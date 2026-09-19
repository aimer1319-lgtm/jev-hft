// A short memory of recent headlines. It answers two questions about a new item:
//
//   - Is it a repeat? The same story often arrives from several sources, or twice from one.
//     A near-identical headline about the same instruments within 30 minutes is skipped, which
//     saves a model call and keeps one event from being counted several times in the results.
//   - What has already been reported? The model cannot know whether a headline is news or a
//     follow-up unless it is shown what came before, so the most related earlier headlines
//     from the last 6 hours go into what it reads.
//
// "Related" is judged by shared words, which is crude but needs no model call. Time is always
// passed in (the items' own receive times), so the memory behaves the same in a test.

import type { NewsItem } from './types.ts';

export type EarlierHeadline = { minutes_ago: number; source: string; headline: string };

type Entry = { id: string; recvTs: number; source: string; headline: string; symbols: Set<string>; words: Set<string>; unanswered?: boolean };

const STOPWORDS = new Set(
  'a an the of to in on for and or by with at from as is are be was were its it this that these those after over under into than then but not no says said say will would has have had can could may amid per via about up down out off more most new'.split(' '),
);

/** The distinct meaningful words of a headline, lower-cased, with simple plurals folded together. */
export function words(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9.%]+/)) {
    let w = raw.replace(/^\.+|\.+$/g, '');
    if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    if (w.length > 1 && !STOPWORDS.has(w)) out.add(w);
  }
  return out;
}

/** Shared words divided by all words: 0 = nothing in common, 1 = the same words. */
export function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

export type RecentNewsOptions = {
  /** How far back earlier headlines are offered as context. */
  windowMs?: number;
  /** How far back a near-identical headline counts as a repeat. */
  duplicateWindowMs?: number;
  /** Word overlap at or above which two headlines are the same story retold. */
  duplicateSimilarity?: number;
  /** Word overlap needed for a headline about a broad instrument to count as related. */
  relatedSimilarity?: number;
  /** Instruments so broad that sharing them says little (Bitcoin, index funds). */
  broadSymbols?: string[];
};

export class RecentNews {
  private entries: Entry[] = [];
  private readonly windowMs: number;
  private readonly duplicateWindowMs: number;
  private readonly duplicateSimilarity: number;
  private readonly relatedSimilarity: number;
  private readonly broad: Set<string>;

  constructor(opts: RecentNewsOptions = {}) {
    this.windowMs = opts.windowMs ?? 6 * 3600_000;
    this.duplicateWindowMs = opts.duplicateWindowMs ?? 30 * 60_000;
    this.duplicateSimilarity = opts.duplicateSimilarity ?? 0.8;
    this.relatedSimilarity = opts.relatedSimilarity ?? 0.2;
    this.broad = new Set(opts.broadSymbols ?? ['BTC-USD', 'SPY', 'QQQ', 'DIA', 'IWM']);
  }

  /** Remember an item (call once, when it arrives). */
  add(item: NewsItem, symbols: string[]) {
    this.entries.push({
      id: item.id,
      recvTs: item.recvTs,
      source: item.sourceLabel ?? item.source,
      headline: item.headline,
      symbols: new Set(symbols),
      words: words(item.headline),
    });
    const cutoff = item.recvTs - this.windowMs;
    if (this.entries.length > 256 && this.entries[0]!.recvTs < cutoff) this.entries = this.entries.filter(e => e.recvTs >= cutoff);
  }

  /**
   * The model never answered about this item (it was skipped, or every call failed). It still
   * counts as known news for later items, but it must not make a later report of the same story
   * look like a repeat, or the story would never be asked about at all.
   */
  unanswered(id: string) {
    const e = this.entries.findLast(x => x.id === id);
    if (e) e.unanswered = true;
  }

  /** The earlier item this one repeats, if any. */
  duplicateOf(item: NewsItem, symbols: string[]): { id: string; headline: string } | undefined {
    const w = words(item.headline);
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      if (e.recvTs < item.recvTs - this.duplicateWindowMs) break;
      if (e.id !== item.id && !e.unanswered && symbols.some(s => e.symbols.has(s)) && similarity(w, e.words) >= this.duplicateSimilarity) return e;
    }
    return undefined;
  }

  /**
   * Up to `max` earlier headlines worth showing next to this one, newest first. An earlier
   * headline qualifies if it shares a single-company ticker with the item (company news within
   * a few hours is nearly always the same story developing), or if it shares a broad instrument
   * and enough words. `now` is when the model will read it, which sets "minutes ago".
   */
  related(item: NewsItem, symbols: string[], now: number, max = 5): EarlierHeadline[] {
    const w = words(item.headline);
    const specific = symbols.filter(s => !this.broad.has(s));
    return this.entries
      .filter(e => e.id !== item.id && e.recvTs <= item.recvTs && e.recvTs >= item.recvTs - this.windowMs && symbols.some(s => e.symbols.has(s)))
      .map(e => ({ e, score: similarity(w, e.words) }))
      .filter(({ e, score }) => score >= this.relatedSimilarity || specific.some(s => e.symbols.has(s)))
      .sort((a, b) => b.score - a.score || b.e.recvTs - a.e.recvTs)
      .slice(0, max)
      .sort((a, b) => b.e.recvTs - a.e.recvTs)
      .map(({ e }) => ({ minutes_ago: Math.max(0, Math.round((now - e.recvTs) / 60_000)), source: e.source, headline: e.headline.slice(0, 200) }));
  }
}
