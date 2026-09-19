// Top-of-book mid history per symbol, for instruments priced from quotes (US stocks).
// The same `midAt` semantics as MarketState: the last known mid at or before t.

type Series = { t: number[]; mid: number[]; bid: number; ask: number };

export class QuoteBook {
  private series = new Map<string, Series>();
  private readonly retentionMs: number;

  constructor(retentionMs: number) {
    this.retentionMs = retentionMs;
  }

  /** A streamed quote received at local time t. One-sided or crossed quotes are ignored. */
  update(symbol: string, t: number, bid: number, ask: number) {
    if (!(bid > 0 && ask >= bid)) return;
    const s = this.get(symbol);
    s.bid = bid;
    s.ask = ask;
    const mid = (bid + ask) / 2;
    const n = s.t.length;
    if (n > 0 && (t < s.t[n - 1]! || s.mid[n - 1] === mid)) return;
    s.t.push(t);
    s.mid.push(mid);
    if (s.t.length > 2048 && s.t[512]! < t - this.retentionMs) {
      const cut = s.t.findIndex(x => x >= t - this.retentionMs);
      s.t.splice(0, cut - 1);
      s.mid.splice(0, cut - 1);
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
    if (!s.bid) {
      s.bid = bid;
      s.ask = ask;
    }
  }

  midAt(symbol: string, t: number): number {
    const s = this.series.get(symbol);
    if (!s) return NaN;
    let lo = 0;
    let hi = s.t.length;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (s.t[m]! <= t) lo = m + 1;
      else hi = m;
    }
    return lo === 0 ? NaN : s.mid[lo - 1]!;
  }

  mid(symbol: string): number {
    const s = this.series.get(symbol);
    return s && s.mid.length > 0 ? s.mid[s.mid.length - 1]! : NaN;
  }

  spreadBps(symbol: string): number {
    const s = this.series.get(symbol);
    return s && s.bid > 0 ? ((s.ask - s.bid) / ((s.ask + s.bid) / 2)) * 1e4 : NaN;
  }

  /** Forget a symbol (after its subscription ends, its history would go stale). */
  drop(symbol: string) {
    this.series.delete(symbol);
  }

  private get(symbol: string): Series {
    let s = this.series.get(symbol);
    if (!s) this.series.set(symbol, (s = { t: [], mid: [], bid: 0, ask: 0 }));
    return s;
  }
}
