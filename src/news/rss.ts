// RSS 2.0 / Atom / RSS 1.0 poller for public feeds.
//
// Polite by construction: one request in flight per feed, conditional GET (ETag /
// Last-Modified -> 304), jittered interval, exponential backoff on errors, and Retry-After
// honored. Items already in the feed at startup are backlog and are never emitted.

import { XMLParser } from 'fast-xml-parser';
import { nowMs } from '../feed/types.ts';
import type { NewsItem, NewsSource, SourceStats } from './types.ts';

/** `symbols`: the instruments this feed's news is about (routing for items that carry no tags). */
export type FeedConfig = { name: string; url: string; symbols?: string[] };
export type PollOptions = { intervalMs: number; userAgent: string; log: (s: string) => void };

const MAX_SEEN = 5000;
const SUMMARY_CHARS = 500;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  htmlEntities: true,
  parseTagValue: false, // keep guids and titles as strings ("2026" must not become a number)
});

export function rssSource(feed: FeedConfig, opts: PollOptions, onItem: (item: NewsItem) => void): NewsSource {
  // sec.gov's fair access policy requires automated clients to identify themselves with contact info.
  if (new URL(feed.url).hostname.endsWith('sec.gov') && !process.env.NEWS_USER_AGENT) {
    throw new Error(`Feed "${feed.name}" is on sec.gov, which requires NEWS_USER_AGENT="Your Name your-email@example.com"`);
  }

  const stats: SourceStats = { polls: 0, notModified: 0, items: 0, errors: 0 };
  const seen = new Set<string>();
  let etag: string | undefined;
  let lastModified: string | undefined;
  let primed = false;
  let failures = 0;
  let closed = false;
  let timer: NodeJS.Timeout | undefined;

  const schedule = (ms: number) => {
    if (!closed) timer = setTimeout(poll, ms * (0.9 + 0.2 * Math.random()));
  };

  async function poll() {
    stats.polls++;
    const headers: Record<string, string> = {
      'User-Agent': opts.userAgent,
      Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5',
    };
    if (etag) headers['If-None-Match'] = etag;
    if (lastModified) headers['If-Modified-Since'] = lastModified;
    try {
      const res = await fetch(feed.url, { headers, signal: AbortSignal.timeout(10_000) });
      const recvTs = nowMs();
      if (res.status === 304) {
        stats.notModified++;
        failures = 0;
        return schedule(opts.intervalMs);
      }
      if (!res.ok) {
        const retryAfterS = Number(res.headers.get('retry-after'));
        throw Object.assign(new Error(`HTTP ${res.status}`), {
          retryAfterMs: Number.isFinite(retryAfterS) ? retryAfterS * 1000 : 0,
        });
      }
      etag = res.headers.get('etag') ?? undefined;
      lastModified = res.headers.get('last-modified') ?? undefined;
      const items = parseFeed(await res.text(), feed.name, recvTs);
      const fresh = items.filter(i => !seen.has(i.id));
      for (const i of fresh) remember(i.id);
      if (!primed) {
        primed = true;
        opts.log(`[news:${feed.name}] ${items.length} items already in feed (backlog, ignored)`);
      } else {
        fresh.sort((a, b) => (a.publishedTs ?? 0) - (b.publishedTs ?? 0));
        for (const i of fresh) {
          stats.items++;
          onItem(feed.symbols ? { ...i, symbols: feed.symbols } : i);
        }
      }
      failures = 0;
      schedule(opts.intervalMs);
    } catch (error) {
      stats.errors++;
      failures++;
      const wait = Math.max(Math.min(opts.intervalMs * 2 ** failures, 5 * 60_000), (error as { retryAfterMs?: number }).retryAfterMs ?? 0);
      opts.log(`[news:${feed.name}] ${(error as Error).message}; retrying in ${(wait / 1000).toFixed(0)}s`);
      schedule(wait);
    }
  }

  // Sets iterate in insertion order, so the first key is the oldest.
  const remember = (id: string) => {
    seen.add(id);
    if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value!);
  };

  void poll();
  return {
    name: feed.name,
    stats,
    close() {
      closed = true;
      clearTimeout(timer);
    },
  };
}

/** Parse RSS 2.0, Atom, or RSS 1.0 (RDF) into news items. Exported for tests and tooling. */
export function parseFeed(xml: string, source: string, recvTs: number): NewsItem[] {
  const doc = parser.parse(xml);
  const raw = doc?.rss?.channel?.item ?? doc?.feed?.entry ?? doc?.['rdf:RDF']?.item ?? [];
  const entries: Record<string, unknown>[] = Array.isArray(raw) ? raw : [raw];
  return entries.flatMap(e => {
    const headline = clean(text(e.title));
    if (!headline) return [];
    const url = link(e.link);
    const published = Date.parse(text(e.pubDate) || text(e.published) || text(e.updated) || text(e['dc:date']));
    const summary = clean(text(e.description) || text(e.summary) || text(e.content) || text(e['content:encoded'])).slice(0, SUMMARY_CHARS);
    return [
      {
        id: `${source}:${text(e.guid) || text(e.id) || url || headline}`,
        source,
        headline,
        ...(summary ? { summary } : {}),
        ...(url ? { url } : {}),
        ...(Number.isFinite(published) ? { publishedTs: published } : {}),
        recvTs,
      },
    ];
  });
}

// Element text: plain string, or {'#text': ...} when the element also has attributes.
function text(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') return Array.isArray(v) ? text(v[0]) : text((v as Record<string, unknown>)['#text']);
  return String(v).trim();
}

// RSS: <link>url</link>. Atom: <link href="..." rel="alternate"/>, possibly several.
function link(v: unknown): string | undefined {
  const links = Array.isArray(v) ? v : v == null ? [] : [v];
  for (const l of links) {
    if (typeof l === 'string' && l.trim()) return l.trim();
    if (l && typeof l === 'object') {
      const o = l as Record<string, string>;
      if (o['@href'] && (!o['@rel'] || o['@rel'] === 'alternate')) return o['@href'];
    }
  }
  return undefined;
}

// Summaries often carry HTML (in CDATA, where entities are not decoded by the XML parser).
function clean(s: string): string {
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/g, (_, e) => ({ nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" })[e as string]!)
    .replace(/\s+/g, ' ')
    .trim();
}
