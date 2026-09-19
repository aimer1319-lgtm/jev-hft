// Market state folded from events: book, trade tape, mid history, and 1 Hz feature
// history used to express features as z-scores. Driven only by event timestamps,
// so replaying recorded events reproduces live behavior exactly.

import type { Aggressor, MarketEvent } from '../feed/types.ts';
import { OrderBook } from './book.ts';

export type Features = {
  t: number; // state time (local receive clock)
  exchTs: number; // exchange timestamp of the latest event folded in
  bid: number;
  ask: number;
  mid: number;
  spreadBps: number;
  microBps: number; // L1 microprice minus mid (= imb1 x half-spread; ~0 when the spread is one tick)
  imb1: number; // (bid - ask) / (bid + ask) size over best N levels
  imb5: number;
  imb20: number;
  depthBid10: number; // size within 10 bps of mid
  depthAsk10: number;
  ret1: number; // mid return over trailing window, bps
  ret5: number;
  ret30: number;
  ret60: number;
  vol60: number; // std of 1 s mid returns over 60 s, bps
  flow1: number; // taker buy minus taker sell volume, base units
  flow5: number;
  flow30: number;
  trades5: number;
  buys5: number;
  sells5: number;
  maxTrade5: number;
  maxTradeSide5: Aggressor | null;
};

/** Features tracked at 1 Hz so the encoder can say how unusual a value is. */
export const NORMALIZED = ['ret5', 'flow5', 'imb1', 'imb5', 'vol60', 'trades5'] as const;
type NormKey = (typeof NORMALIZED)[number];

type Trade = { t: number; size: number; aggressor: Aggressor };

const TRADE_WINDOW_MS = 30_000;

export class MarketState {
  readonly book = new OrderBook();
  ready = false;
  lastExchTs = NaN;
  lastRecvTs = NaN;

  private trades: Trade[] = [];
  private midT: number[] = [];
  private midV: number[] = [];
  private secMids: number[] = [];
  private lastSec = 0;
  private history = new Map<NormKey, number[]>(NORMALIZED.map(k => [k, []]));

  /** How long to keep mid history; must cover the longest forward-return horizon. */
  private readonly midRetentionMs: number;
  private readonly normWindow: number;

  constructor(midRetentionMs = 5 * 60_000, normWindow = 600) {
    this.midRetentionMs = midRetentionMs;
    this.normWindow = normWindow;
  }

  apply(e: MarketEvent) {
    this.lastRecvTs = e.recvTs;
    if (e.type === 'reset') {
      this.book.clear();
      this.ready = false;
      return;
    }
    this.lastExchTs = e.exchTs;
    if (e.type === 'book') {
      if (e.snapshot) {
        this.book.load(e.updates);
        this.ready = this.book.ready;
      } else {
        for (const u of e.updates) this.book.apply(u.side, u.price, u.size);
      }
      if (this.ready) this.recordMid(e.recvTs);
    } else {
      this.trades.push({ t: e.recvTs, size: e.size, aggressor: e.aggressor });
      this.prune(e.recvTs);
    }
    if (this.ready) this.sampleSecond(e.recvTs);
  }

  /** Mid as of time `t` (last known value at or before t). */
  midAt(t: number): number {
    let lo = 0;
    let hi = this.midT.length;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (this.midT[m]! <= t) lo = m + 1;
      else hi = m;
    }
    return lo === 0 ? NaN : this.midV[lo - 1]!;
  }

  /** Earliest time still covered by mid history. */
  get historyStart() {
    return this.midT[0] ?? NaN;
  }

  features(t = this.lastRecvTs): Features {
    const b = this.book;
    const bid = b.bestBid;
    const ask = b.bestAsk;
    const mid = (bid + ask) / 2;
    const bidSz1 = b.level('bid', 0)?.[1] ?? 0;
    const askSz1 = b.level('ask', 0)?.[1] ?? 0;
    const micro = (bid * askSz1 + ask * bidSz1) / (bidSz1 + askSz1);
    const imb = (n: number) => {
      const bs = b.topSize('bid', n);
      const as = b.topSize('ask', n);
      return (bs - as) / (bs + as);
    };
    const ret = (ms: number) => bps(mid, this.midAt(t - ms));

    let flow1 = 0, flow5 = 0, flow30 = 0, trades5 = 0, buys5 = 0, sells5 = 0, maxTrade5 = 0;
    let maxTradeSide5: Aggressor | null = null;
    for (let i = this.trades.length - 1; i >= 0; i--) {
      const tr = this.trades[i]!;
      const age = t - tr.t;
      if (age > 30_000) break;
      const signed = tr.aggressor === 'buy' ? tr.size : -tr.size;
      flow30 += signed;
      if (age <= 5_000) {
        flow5 += signed;
        trades5++;
        tr.aggressor === 'buy' ? buys5++ : sells5++;
        if (tr.size > maxTrade5) {
          maxTrade5 = tr.size;
          maxTradeSide5 = tr.aggressor;
        }
      }
      if (age <= 1_000) flow1 += signed;
    }

    const rets: number[] = [];
    for (let i = 1; i < this.secMids.length; i++) rets.push(bps(this.secMids[i]!, this.secMids[i - 1]!));

    return {
      t,
      exchTs: this.lastExchTs,
      bid,
      ask,
      mid,
      spreadBps: bps(ask, bid),
      microBps: bps(micro, mid),
      imb1: imb(1),
      imb5: imb(5),
      imb20: imb(20),
      depthBid10: b.depthWithin('bid', 10),
      depthAsk10: b.depthWithin('ask', 10),
      ret1: ret(1_000),
      ret5: ret(5_000),
      ret30: ret(30_000),
      ret60: ret(60_000),
      vol60: std(rets),
      flow1,
      flow5,
      flow30,
      trades5,
      buys5,
      sells5,
      maxTrade5,
      maxTradeSide5,
    };
  }

  /** z-score of `value` against the trailing 1 Hz history of `key` (NaN until warmed up). */
  z(key: NormKey, value: number): number {
    const h = this.history.get(key)!;
    if (h.length < 60) return NaN;
    const mean = h.reduce((a, b) => a + b, 0) / h.length;
    const sd = Math.sqrt(h.reduce((a, b) => a + (b - mean) ** 2, 0) / (h.length - 1));
    return sd > 0 ? (value - mean) / sd : 0;
  }

  private recordMid(t: number) {
    const mid = this.book.mid;
    if (this.midV[this.midV.length - 1] === mid) return;
    this.midT.push(t);
    this.midV.push(mid);
    // Batch-trim old history instead of shifting per event.
    if (this.midT.length > 4096 && this.midT[1024]! < t - this.midRetentionMs) {
      const cut = this.midT.findIndex(x => x >= t - this.midRetentionMs);
      this.midT.splice(0, cut - 1);
      this.midV.splice(0, cut - 1);
    }
  }

  private prune(t: number) {
    if (this.trades.length > 2048 && this.trades[1024]!.t < t - TRADE_WINDOW_MS) {
      this.trades.splice(0, this.trades.findIndex(x => x.t >= t - TRADE_WINDOW_MS));
    }
  }

  private sampleSecond(t: number) {
    const sec = Math.floor(t / 1000);
    if (sec <= this.lastSec) return;
    const first = this.lastSec === 0;
    this.lastSec = sec;
    this.secMids.push(this.book.mid);
    if (this.secMids.length > 61) this.secMids.shift();
    if (first) return;
    const f = this.features(t);
    for (const key of NORMALIZED) {
      const h = this.history.get(key)!;
      const v = f[key];
      if (Number.isFinite(v)) h.push(v);
      if (h.length > this.normWindow) h.shift();
    }
  }
}

function bps(a: number, b: number) {
  return ((a - b) / b) * 1e4;
}

function std(xs: number[]) {
  if (xs.length < 2) return NaN;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
}
