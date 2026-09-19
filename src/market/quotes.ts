// Top-of-book history per symbol, for instruments priced from quotes (US stocks).
// The same `midAt` semantics as MarketState: the last known mid at or before t, and NaN
// (unknown) for times when the connection that delivers the quotes was down.
//
// Each point also keeps the quote's spread, because a stock's mid is only a usable price
// when its bid and ask are close together.

type Series = { t: number[]; mid: number[]; spread: number[] };

const spreadBps = (bid: number, ask: number) => ((ask - bid) / ((ask + bid) / 2)) * 1e4;

export class QuoteBook {
  private series = new Map<string, Series>();
  private readonly retentionMs: number;
  /** Periods with no live connection: (last message, resubscribed). Oldest first. */
  private gaps: [from: number, to: number][] = [];
  private gapFrom = NaN;

  constructor(retentionMs: number) {
    this.retentionMs = retentionMs;
  }

  /** A quote received at local time t. One-sided or crossed quotes are ignored. */
  update(symbol: string, t: number, bid: number, ask: number) {
    if (!(bid > 0 && ask >= bid)) return;
    const s = this.get(symbol);
    const mid = (bid + ask) / 2;
    const spread = spreadBps(bid, ask);
    const n = s.t.length;
    if (n > 0 && (t < s.t[n - 1]! || (s.mid[n - 1] === mid && s.spread[n - 1] === spread))) return;
    s.t.push(t);
    s.mid.push(mid);
    s.spread.push(spread);
    if (s.t.length > 2048 && s.t[512]! < t - this.retentionMs) {
      const cut = s.t.findIndex(x => x >= t - this.retentionMs);
      s.t.splice(0, cut - 1);
      s.mid.splice(0, cut - 1);
      s.spread.splice(0, cut - 1);
      this.gaps = this.gaps.filter(g => g[1] >= t - this.retentionMs);
    }
  }

  /**
   * A first observation for a symbol not yet streaming (a REST snapshot), placed at time t.
   * Ignored if something is already known at or before t.
   */
  seed(symbol: string, t: number, bid: number, ask: number) {
    if (!(bid > 0 && ask >= bid)) return;
    const s = this.get(symbol);
    if (s.t.length > 0 && s.t[0]! <= t) return;
    s.t.unshift(t);
    s.mid.unshift((bid + ask) / 2);
    s.spread.unshift(spreadBps(bid, ask));
  }

  /**
   * Prices from before we started watching (minute bars), oldest first. They fill in only the
   * time before the first thing we already know, and carry no spread. They give the model
   * "what has this stock been doing" and are never used to measure what happened afterwards.
   */
  seedHistory(symbol: string, points: { t: number; price: number }[]) {
    const s = this.get(symbol);
    const before = s.t[0] ?? Infinity;
    const older = points.filter(p => p.price > 0 && p.t < before);
    s.t.unshift(...older.map(p => p.t));
    s.mid.unshift(...older.map(p => p.price));
    s.spread.unshift(...older.map(() => NaN));
  }

  /** The connection dropped; nothing after `t` (the last message we got) can be trusted. */
  markGap(t: number) {
    if (Number.isNaN(this.gapFrom)) this.gapFrom = t;
  }

  /** Quotes are flowing again as of `t`. */
  resume(t: number) {
    if (Number.isNaN(this.gapFrom)) return;
    this.gaps.push([this.gapFrom, t]);
    this.gapFrom = NaN;
  }

  midAt(symbol: string, t: number): number {
    const i = this.indexAt(symbol, t);
    return i < 0 ? NaN : this.series.get(symbol)!.mid[i]!;
  }

  /** Spread of the quote in force at time t, in basis points (NaN when unknown). */
  spreadAt(symbol: string, t: number): number {
    const i = this.indexAt(symbol, t);
    return i < 0 ? NaN : this.series.get(symbol)!.spread[i]!;
  }

  mid(symbol: string): number {
    const s = this.series.get(symbol);
    return s && s.mid.length > 0 && Number.isNaN(this.gapFrom) ? s.mid[s.mid.length - 1]! : NaN;
  }

  spreadBps(symbol: string): number {
    const s = this.series.get(symbol);
    return s && s.spread.length > 0 && Number.isNaN(this.gapFrom) ? s.spread[s.spread.length - 1]! : NaN;
  }

  /** Forget a symbol (after its subscription ends, its history would go stale). */
  drop(symbol: string) {
    this.series.delete(symbol);
  }

  /** Index of the last point at or before t; -1 if there is none or t falls in a gap. */
  private indexAt(symbol: string, t: number): number {
    const s = this.series.get(symbol);
    if (!s) return -1;
    if (t > this.gapFrom) return -1; // false when gapFrom is NaN
    for (let i = this.gaps.length - 1; i >= 0 && this.gaps[i]![1] > t; i--) if (t > this.gaps[i]![0]) return -1;
    let lo = 0;
    let hi = s.t.length;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (s.t[m]! <= t) lo = m + 1;
      else hi = m;
    }
    return lo - 1;
  }

  private get(symbol: string): Series {
    let s = this.series.get(symbol);
    if (!s) this.series.set(symbol, (s = { t: [], mid: [], spread: [] }));
    return s;
  }
}
