// Posts from a configured list of X accounts, read through X's official API: recent search
// with the app-only bearer token (read-only).
//
// X bills per thing read: $0.005 a post and $0.010 a user profile. So the source reads only posts
// published from startup on (no billed backlog), excludes retweets and replies, covers all
// accounts in one query per poll, and stops reading for the rest of the UTC day at
// X_MAX_POSTS_PER_DAY. It never asks for author profiles alongside posts: the accounts' ids are
// looked up once, saved in data/cache/x-users.json, and matched against each post's author id.
// Searches that find nothing cost nothing, which is why polling often is affordable.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { nowMs } from '../feed/types.ts';
import { poller, type PollError } from '../lib/poll.ts';
import { SeenSet } from '../lib/seen.ts';
import { normalizeCashtag } from './instruments.ts';
import type { NewsItem, NewsSource, SourceStats } from './types.ts';

const API = 'https://api.x.com/2';
const MAX_QUERY_CHARS = 512;
const USERS_CACHE = 'data/cache/x-users.json';

export type XOptions = {
  bearer: string;
  accounts: string[];
  intervalMs: number;
  maxPostsPerDay: number;
  log: (s: string) => void;
  /** Where account ids are remembered between runs. */
  usersCache?: string;
};

type Post = { id: string; text: string; created_at?: string; author_id?: string; entities?: { cashtags?: { tag: string }[] } };
type SearchResponse = { data?: Post[]; meta?: { newest_id?: string; result_count?: number; next_token?: string } };
type UsersResponse = { data?: { id: string; username: string }[] };

/** `(from:a OR from:b ...) -is:retweet -is:reply`, split so each query fits X's length limit. */
export function buildQueries(accounts: string[]): string[] {
  const suffix = ' -is:retweet -is:reply';
  const queries: string[] = [];
  let group: string[] = [];
  const render = (g: string[]) => `(${g.map(a => `from:${a}`).join(' OR ')})${suffix}`;
  for (const account of accounts) {
    if (group.length > 0 && render([...group, account]).length > MAX_QUERY_CHARS) {
      queries.push(render(group));
      group = [];
    }
    group.push(account);
  }
  if (group.length > 0) queries.push(render(group));
  return queries;
}

export function xSource(opts: XOptions, onItem: (item: NewsItem) => void): NewsSource {
  const stats: SourceStats = { polls: 0, notModified: 0, items: 0, errors: 0 };
  const queries = buildQueries(opts.accounts);
  const sinceId = new Map<string, string>();
  // First poll: only posts from startup on. X requires start_time at least 10 s in the past,
  // so the window opens 15 s before startup.
  const startTime = new Date(Date.now() - 15_000).toISOString();
  const seen = new SeenSet();
  const cacheFile = opts.usersCache ?? USERS_CACHE;
  const authors = loadAuthors(cacheFile); // author id -> handle
  let nextLookupAt = 0;
  const utcDay = () => new Date().toISOString().slice(0, 10);
  let day = utcDay();
  let readToday = 0;
  let paused = false;

  const get = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${opts.bearer}` }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 160);
      const reset = Number(res.headers.get('x-rate-limit-reset'));
      throw Object.assign(new Error(`HTTP ${res.status} ${detail}`), {
        retryAfterMs: res.status === 429 && Number.isFinite(reset) ? Math.max(reset * 1000 - Date.now(), 1000) : 0,
        // Credentials or billing problems will not fix themselves in seconds.
        fatal: res.status === 401 || res.status === 402 || res.status === 403,
      } satisfies Partial<PollError>);
    }
    return (await res.json()) as T;
  };

  /** Learn the ids of accounts we cannot name yet. Billed per profile, so at most once per account. */
  async function resolveAuthors() {
    const known = new Set([...authors.values()].map(h => h.toLowerCase()));
    const missing = opts.accounts.filter(a => !known.has(a.toLowerCase()));
    if (missing.length === 0 || Date.now() < nextLookupAt) return;
    nextLookupAt = Date.now() + 10 * 60_000;
    try {
      for (let i = 0; i < missing.length; i += 100) {
        const body = await get<UsersResponse>(`/users/by?usernames=${missing.slice(i, i + 100).map(encodeURIComponent).join(',')}`);
        for (const u of body.data ?? []) authors.set(u.id, u.username);
      }
      mkdirSync(dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(authors), null, 2));
    } catch (error) {
      opts.log(`[news:x] could not look up account ids (${(error as Error).message}); posts will show the author's id instead of their name`);
    }
  }

  async function poll() {
    if (utcDay() !== day) {
      day = utcDay();
      readToday = 0;
    }
    const overBudget = readToday >= opts.maxPostsPerDay;
    if (overBudget && !paused) opts.log(`[news:x] daily budget of ${opts.maxPostsPerDay} posts reached; paused until 00:00 UTC`);
    paused = overBudget;
    if (paused) return;
    stats.polls++;
    await resolveAuthors();
    for (const query of queries) await pollQuery(query);
  }

  async function pollQuery(query: string) {
    const items: NewsItem[] = [];
    let newest: string | undefined;
    let next: string | undefined;
    do {
      const params = new URLSearchParams({ query, max_results: '100', 'tweet.fields': 'created_at,entities,author_id' });
      const since = sinceId.get(query);
      if (since) params.set('since_id', since);
      else params.set('start_time', startTime);
      if (next) params.set('next_token', next);
      const body = await get<SearchResponse>(`/tweets/search/recent?${params}`);
      const recvTs = nowMs();
      for (const post of body.data ?? []) items.push(toItem(post, authors, recvTs));
      readToday += body.meta?.result_count ?? 0;
      newest ??= body.meta?.newest_id;
      next = body.meta?.next_token;
    } while (next && readToday < opts.maxPostsPerDay);
    if (newest) sinceId.set(query, newest);

    items.sort((a, b) => (a.publishedTs ?? 0) - (b.publishedTs ?? 0));
    for (const item of items) {
      if (!seen.add(item.id)) continue;
      stats.items++;
      onItem(item);
    }
  }

  opts.log(`[news:x] following ${opts.accounts.length} accounts in ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}; budget ${opts.maxPostsPerDay} posts/day`);
  const loop = poller({
    intervalMs: () => (paused ? 60_000 : opts.intervalMs),
    run: poll,
    onError: (error, wait) => {
      stats.errors++;
      opts.log(`[news:x] ${error.message}; retrying in ${(wait / 1000).toFixed(0)}s`);
    },
  });
  return { name: 'x', stats, close: () => loop.close() };
}

function loadAuthors(file: string): Map<string, string> {
  try {
    return new Map(Object.entries(JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>));
  } catch {
    return new Map(); // no cache yet
  }
}

/** A post as a news item. Cashtags choose instruments, like Alpaca's ticker tags. */
export function toItem(post: Post, authors: Map<string, string>, recvTs: number): NewsItem {
  const handle = authors.get(post.author_id ?? '');
  const published = Date.parse(post.created_at ?? '');
  const cashtags = post.entities?.cashtags ?? [];
  const symbols = [...new Set(cashtags.map(c => normalizeCashtag(c.tag)).filter((s): s is string => s !== undefined))];
  return {
    id: `x:${post.id}`,
    source: `x:${handle ?? post.author_id ?? 'unknown'}`,
    sourceLabel: handle ? `X post by @${handle}` : 'X post',
    headline: post.text.replace(/\s+/g, ' ').trim().slice(0, 500),
    url: `https://x.com/${handle ?? 'i'}/status/${post.id}`,
    ...(Number.isFinite(published) ? { publishedTs: published } : {}),
    recvTs,
    // No cashtags: the untagged route. Cashtags we cannot price only: skipped (empty list).
    ...(cashtags.length > 0 ? { symbols } : {}),
  };
}
