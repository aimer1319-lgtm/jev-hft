import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MarketEvent } from '../src/feed/types.ts';
import { replayer } from '../src/market/replay.ts';
import { MarketState } from '../src/market/state.ts';

const T0 = 1_800_000_000_000;
const snapshot = (t: number, bid: number, ask: number): MarketEvent => ({
  type: 'book',
  snapshot: true,
  updates: [
    { side: 'bid', price: bid, size: 1 },
    { side: 'ask', price: ask, size: 1 },
  ],
  exchTs: t - 50,
  recvTs: t,
});
/** Move the best bid and ask together so the mid becomes `mid` (clearing the previous touch). */
const quote = (t: number, was: number, mid: number): MarketEvent => ({
  type: 'book',
  snapshot: false,
  updates: [
    { side: 'bid', price: was - 0.5, size: 0 },
    { side: 'ask', price: was + 0.5, size: 0 },
    { side: 'bid', price: mid - 0.5, size: 1 },
    { side: 'ask', price: mid + 0.5, size: 1 },
  ],
  exchTs: t - 50,
  recvTs: t,
});
const trade = (t: number, size: number, aggressor: 'buy' | 'sell'): MarketEvent => ({ type: 'trade', price: 100, size, aggressor, exchTs: t - 80, recvTs: t });

test('midAt is the last mid known at or before a time, never a later one', () => {
  const s = new MarketState();
  s.apply(snapshot(T0, 99.5, 100.5));
  s.apply(quote(T0 + 1000, 100, 101));
  s.apply(quote(T0 + 2000, 101, 103));
  assert.ok(Number.isNaN(s.midAt(T0 - 1)), 'before anything was known');
  assert.equal(s.midAt(T0), 100);
  assert.equal(s.midAt(T0 + 999), 100);
  assert.equal(s.midAt(T0 + 1000), 101);
  assert.equal(s.midAt(T0 + 5000), 103);
});

test('while the feed is broken the price is unknown, not unchanged', () => {
  const s = new MarketState();
  s.apply(snapshot(T0, 99.5, 100.5));
  s.apply(quote(T0 + 1000, 100, 101));
  s.apply({ type: 'reset', recvTs: T0 + 4000 }); // lost some time after the last good event
  assert.equal(s.ready, false);
  assert.equal(s.midAt(T0 + 1000), 101, 'the last good event is still good');
  assert.ok(Number.isNaN(s.midAt(T0 + 2500)), 'inside the gap, before it was noticed');
  assert.ok(Number.isNaN(s.midAt(T0 + 60_000)), 'the gap is still open');
  s.apply({ type: 'reset', recvTs: T0 + 5000 }); // a second reset does not move the start of the gap
  s.apply(snapshot(T0 + 6000, 104.5, 105.5));
  assert.equal(s.ready, true);
  assert.ok(Number.isNaN(s.midAt(T0 + 5999)), 'inside the closed gap');
  assert.equal(s.midAt(T0 + 6000), 105);
  assert.equal(s.midAt(T0 + 1000), 101, 'history before the gap survives');
  // A return that would have to start inside the gap is unknown.
  assert.ok(Number.isNaN(s.features(T0 + 6500).ret5));
});

test('taker flow is signed by who made the trade happen and limited to its window', () => {
  const s = new MarketState();
  s.apply(snapshot(T0, 99.5, 100.5));
  s.apply(trade(T0 + 1000, 2, 'buy')); // 9 s before the snapshot below
  s.apply(trade(T0 + 7000, 1, 'sell')); // 3 s before
  s.apply(trade(T0 + 9500, 0.25, 'buy')); // 0.5 s before
  const f = s.features(T0 + 10_000);
  assert.equal(f.flow1, 0.25);
  assert.equal(f.flow5, -0.75);
  assert.equal(f.flow30, 1.25);
  assert.equal(f.trades5, 2);
  assert.equal(f.buys5, 1);
  assert.equal(f.sells5, 1);
  assert.equal(f.maxTrade5, 1);
  assert.equal(f.maxTradeSide5, 'sell');
});

test('returns look back from the snapshot time and are unknown without enough history', () => {
  const s = new MarketState();
  s.apply(snapshot(T0, 99.5, 100.5));
  s.apply(quote(T0 + 4000, 100, 101));
  const f = s.features(T0 + 6000);
  assert.ok(Math.abs(f.ret5 - 100) < 1e-9, '1% = 100 bp over the last 5 s');
  assert.equal(f.ret1, 0);
  assert.ok(Number.isNaN(f.ret30), 'no price 30 s ago');
  assert.equal(f.imb1, 0);
  assert.ok(Math.abs(f.spreadBps - (1 / 100.5) * 1e4) < 1e-9);
});

test('a replayed snapshot knows nothing that arrived at or after its own time', () => {
  const s = new MarketState(Infinity);
  const seen: { t: number; mid: number; lastRecvTs: number }[] = [];
  const feed = replayer(s, 1000, 2000, t => seen.push({ t, mid: s.features(t).mid, lastRecvTs: s.lastRecvTs }));
  feed(snapshot(T0, 99.5, 100.5));
  feed(quote(T0 + 1500, 100, 101));
  feed(quote(T0 + 2000, 101, 102)); // arrives exactly at the first snapshot time
  feed(quote(T0 + 3500, 102, 110));
  feed(quote(T0 + 4000, 110, 120));
  assert.deepEqual(seen.map(x => x.t), [T0 + 2000, T0 + 3000, T0 + 4000]);
  assert.deepEqual(seen.map(x => x.mid), [101, 102, 110], 'each snapshot shows the mid from before its own moment');
  for (const x of seen) assert.ok(x.lastRecvTs < x.t);
});

test('a replay warms up again after the feed breaks', () => {
  const s = new MarketState(Infinity);
  const times: number[] = [];
  const feed = replayer(s, 1000, 2000, t => times.push(t - T0));
  feed(snapshot(T0, 99.5, 100.5));
  feed(quote(T0 + 2500, 100, 101)); // snapshot at 2000
  feed({ type: 'reset', recvTs: T0 + 2600 });
  feed(snapshot(T0 + 5000, 99.5, 100.5));
  feed(quote(T0 + 6500, 100, 101)); // still warming up (until 7000)
  feed(quote(T0 + 7500, 101, 102)); // snapshot at 7000
  assert.deepEqual(times, [2000, 7000]);
});
