// Posts from a configured list of X accounts, read through X's official API: recent search
// with the app-only bearer token (read-only).
//
// X bills pay-per-use per post read, so the source reads only posts published from startup on
// (no billed backlog), excludes retweets and replies, covers all accounts in one query per poll,
// and stops reading for the rest of the UTC day at X_MAX_POSTS_PER_DAY.

import { nowMs } from '../feed/types.ts';
import { normalizeSymbol } from './instruments.ts';
import type { NewsItem, NewsSource, SourceStats } from './types.ts';

const SEARCH = 'https://api.x.com/2/tweets/search/recent';
const MAX_QUERY_CHARS = 512;
const MAX_SEEN = 5000;

export type XOptions = {
  bearer: string;
  accounts: string[];
  intervalMs: number;
  maxPostsPerDay: number;
  log: (s: string) => void;
};

type Post = { id: string; text: string; created_at?: string; author_id?: string; entities?: { cashtags?: { tag: string }[] } };
type SearchResponse = {
  data?: Post[];
  includes?: { users?: { id: string; username: string }[] };
  meta?: { newest_id?: string; result_count?: number; next_token?: string };
};

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
  const seen = new Set<string>();
  const utcDay = () => new Date().toISOString().slice(0, 10);
  let day = utcDay();
  let readToday = 0;
  let budgetLogged = false;
  let failures = 0;
  let closed = false;
  let timer: NodeJS.Timeout | undefined;

  const schedule = (ms: number) => {
    if (!closed) timer = setTimeout(poll, ms * (0.9 + 0.2 * Math.random()));
  };

  async function poll() {
    if (utcDay() !== day) {
      day = utcDay();
      readToday = 0;
      budgetLogged = false;
    }
    if (readToday >= opts.maxPostsPerDay) {
      if (!budgetLogged) opts.log(`[news:x] daily budget of ${opts.maxPostsPerDay} posts reached; paused until 00:00 UTC`);
      budgetLogged = true;
      return schedule(60_000);
    }
    stats.polls++;
    try {
      for (const query of queries) await pollQuery(query);
      failures = 0;
      schedule(opts.intervalMs);
    } catch (error) {
      stats.errors++;
      failures++;
      const { retryAfterMs = 0, fatal = false } = error as { retryAfterMs?: number; fatal?: boolean };
      // Credentials or billing problems will not fix themselves in seconds.
      const wait = fatal ? 10 * 60_000 : Math.max(Math.min(opts.intervalMs * 2 ** failures, 5 * 60_000), retryAfterMs);
      opts.log(`[news:x] ${(error as Error).message}; retrying in ${(wait / 1000).toFixed(0)}s`);
      schedule(wait);
    }
  }

  async function pollQuery(query: string) {
    const items: NewsItem[] = [];
    let newest: string | undefined;
    let next: string | undefined;
    do {
      const params = new URLSearchParams({
        query,
        max_results: '100',
        'tweet.fields': 'created_at,entities,author_id',
        expansions: 'author_id',
        'user.fields': 'username',
      });
      const since = sinceId.get(query);
      if (since) params.set('since_id', since);
      else params.set('start_time', startTime);
      if (next) params.set('next_token', next);
      const res = await fetch(`${SEARCH}?${params}`, {
        headers: { Authorization: `Bearer ${opts.bearer}` },
        signal: AbortSignal.timeout(10_000),
      });
      const recvTs = nowMs();
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 160);
        const reset = Number(res.headers.get('x-rate-limit-reset'));
        throw Object.assign(new Error(`HTTP ${res.status} ${detail}`), {
          retryAfterMs: res.status === 429 && Number.isFinite(reset) ? Math.max(reset * 1000 - Date.now(), 1000) : 0,
          fatal: res.status === 401 || res.status === 402 || res.status === 403,
        });
      }
      const body = (await res.json()) as SearchResponse;
      const users = new Map((body.includes?.users ?? []).map(u => [u.id, u.username]));
      for (const post of body.data ?? []) items.push(toItem(post, users, recvTs));
      readToday += body.meta?.result_count ?? 0;
      newest ??= body.meta?.newest_id;
      next = body.meta?.next_token;
    } while (next && readToday < opts.maxPostsPerDay);
    if (newest) sinceId.set(query, newest);

    items.sort((a, b) => (a.publishedTs ?? 0) - (b.publishedTs ?? 0));
    for (const item of items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value!);
      stats.items++;
      onItem(item);
    }
  }

  opts.log(`[news:x] following ${opts.accounts.length} accounts in ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}; budget ${opts.maxPostsPerDay} posts/day`);
  void poll();
  return {
    name: 'x',
    stats,
    close() {
      closed = true;
      clearTimeout(timer);
    },
  };
}

/** A post as a news item. Cashtags choose instruments, like Alpaca's ticker tags. */
export function toItem(post: Post, users: Map<string, string>, recvTs: number): NewsItem {
  const handle = users.get(post.author_id ?? '') ?? 'unknown';
  const published = Date.parse(post.created_at ?? '');
  const cashtags = post.entities?.cashtags ?? [];
  const symbols = [...new Set(cashtags.map(c => normalizeSymbol(c.tag)).filter((s): s is string => s !== undefined))];
  return {
    id: `x:${post.id}`,
    source: `x:${handle}`,
    headline: post.text.replace(/\s+/g, ' ').trim().slice(0, 500),
    url: `https://x.com/${handle}/status/${post.id}`,
    ...(Number.isFinite(published) ? { publishedTs: published } : {}),
    recvTs,
    // No cashtags: the untagged route. Cashtags we cannot price only: skipped (empty list).
    ...(cashtags.length > 0 ? { symbols } : {}),
  };
}
