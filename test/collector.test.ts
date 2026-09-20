import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DashboardState, LIMITS, type DashboardEvent, type NewsEntry } from '../src/dashboard/collector.ts';

const T0 = 1_800_000_000_000;
let seq = 0;
/** Wraps a message the way the dashboard server does. */
const ev = (body: Record<string, unknown>, t = T0): DashboardEvent => ({ v: 1, t, run: 7, rx: t + 3, seq: ++seq, ...body }) as DashboardEvent;

const pulse = (mid: number | null, t: number) =>
  ev({ type: 'pulse', program: 'live', meta: { provider: 'mock', product: 'BTC-USD', minIntervalMs: 1000, flatSigmas: 2, warmupMs: 0, recording: false }, market: { ready: mid !== null, mid, bid: mid, ask: mid }, stats: { decisions: 0, written: 0, rateLimited: 0, timeouts: 0, errors: 0, costUsd: 0 }, feed: { eventsPerS: 20, lagMs: 90 }, eventCostUs: null }, t);
const ask = (id: number, tState: number) =>
  ev({ type: 'ask', program: 'live', id, tState, state: 'text', flatBps: { dir_2s: 0.5, dir_10s: 1, dir_60s: 3 }, features: { mid: 100, spreadBps: 0.1, imb1: 0.2, imb5: 0.1, imb20: 0, ret5: null, ret60: null, vol60: null, flow5: 0, trades5: 3 } }, tState);
const answer = (id: number, tResp: number) =>
  ev({ type: 'answer', program: 'live', id, tResp, modelMs: 260, providerMs: 160, inputTokens: 850, costUsd: 0.00003, probabilities: { dir_10s: { up: 0.6, flat: 0.3, down: 0.1 } }, confidence: null, signals: { jev_10s: 0.5 }, midResp: 100.1 }, tResp);
const item = (id: string, recvTs: number) => ev({ type: 'news-item', program: 'news', id, source: 'wire', sourceLabel: 'A newswire', headline: `headline ${id}`, url: null, publishedTs: null, recvTs, symbols: ['BTC-USD'] }, recvTs);

test('a pulse says the program is alive and adds to the price history', () => {
  const s = new DashboardState();
  s.apply(pulse(100, T0));
  s.apply(pulse(null, T0 + 1000)); // no order book yet: alive, but no price
  s.apply(pulse(101, T0 + 2000));
  assert.equal(s.live.lastRx, T0 + 2003);
  assert.deepEqual(s.live.ticks, [{ t: T0, mid: 100 }, { t: T0 + 2000, mid: 101 }]);
  assert.equal(s.live.pulse?.market.mid, 101);
  assert.equal(s.news.lastRx, null, 'the other program has not been heard from');
});

test('a question, its answer, and later its outcome end up on one decision', () => {
  const s = new DashboardState();
  s.apply(ask(1, T0));
  s.apply(ask(2, T0 + 1000));
  s.apply(answer(1, T0 + 260));
  s.apply(ev({ type: 'fail', program: 'live', id: 2, kind: 'timeout', message: 'too slow' }));
  s.apply(ev({ type: 'outcome', program: 'live', tState: T0, fromState: { '10': 1.5 }, fromResp: { '10': 1.2 } }));
  const [first, second] = s.live.decisions;
  assert.equal(first!.answer?.modelMs, 260);
  assert.deepEqual(first!.outcome, { fromState: { '10': 1.5 }, fromResp: { '10': 1.2 } });
  assert.deepEqual(second!.failed, { kind: 'timeout', message: 'too slow' });
  assert.equal(second!.answer, undefined);
  // An answer for a question this dashboard never saw (it started in between) is simply ignored.
  s.apply(answer(99, T0 + 5000));
  assert.equal(s.live.decisions.length, 2);
});

test('the same decision number in a new run of the pipeline is a different decision', () => {
  const s = new DashboardState();
  s.apply(ask(1, T0));
  s.apply({ ...ask(1, T0 + 60_000), run: 8 } as DashboardEvent);
  s.apply({ ...answer(1, T0 + 60_260), run: 8 } as DashboardEvent);
  assert.equal(s.live.decisions[0]!.answer, undefined);
  assert.equal(s.live.decisions[1]!.answer?.modelMs, 260);
});

test('a message already reflected is not applied twice, so a snapshot and the stream can overlap', () => {
  const s = new DashboardState();
  const first = ask(1, T0);
  assert.equal(s.apply(first), true);
  assert.equal(s.apply(first), false);
  assert.equal(s.live.decisions.length, 1);

  // A browser loads the snapshot, then receives the stream from a little earlier.
  const browser = DashboardState.from(JSON.parse(JSON.stringify(s.snapshot(T0))));
  assert.equal(browser.apply(first), false);
  assert.equal(browser.apply(answer(1, T0 + 260)), true);
  assert.equal(browser.live.decisions[0]!.answer?.modelMs, 260);
});

test('history is bounded', () => {
  const s = new DashboardState();
  for (let i = 0; i < LIMITS.ticks + 50; i++) s.apply(pulse(100 + i, T0 + i * 1000));
  for (let i = 1; i <= LIMITS.decisions + 50; i++) s.apply(ask(i, T0 + i));
  assert.equal(s.live.ticks.length, LIMITS.ticks);
  assert.equal(s.live.ticks[0]!.mid, 150, 'the oldest were dropped');
  assert.equal(s.live.decisions.length, LIMITS.decisions);
});

test('a headline goes from waiting to answered, skipped, or retried', () => {
  const s = new DashboardState();
  s.apply(item('a', T0));
  s.apply(item('b', T0 + 1));
  s.apply(item('c', T0 + 2));
  assert.deepEqual(s.news.items.map(n => n.status), ['waiting', 'waiting', 'waiting']);

  s.apply(ev({ type: 'news-skip', program: 'news', id: 'a', reason: 'closed', detail: '' }));
  s.apply(ev({ type: 'news-retry', program: 'news', id: 'b', kind: 'failure', message: 'timed out' }));
  assert.equal(s.news.items[1]!.retry?.message, 'timed out');
  s.apply(ev({ type: 'news-answer', program: 'news', id: 'b', tResp: T0 + 900, queueMs: 600, modelMs: 290, providerMs: 150, costUsd: 0.00002, attempts: 2, novel: 0.8, verdicts: [], state: {} }));
  s.apply(ev({ type: 'news-outcome', program: 'news', id: 'b', recvTs: T0 + 1, symbol: 'BTC-USD', moves: { '300': 12.5 } }));

  const [a, b, c] = s.news.items as [NewsEntry, NewsEntry, NewsEntry];
  assert.deepEqual([a.status, a.skip?.reason], ['skipped', 'closed']);
  assert.deepEqual([b.status, b.answer?.attempts, b.retry], ['answered', 2, undefined]);
  assert.deepEqual(b.outcomes, { 'BTC-USD': { '300': 12.5 } });
  assert.equal(c.status, 'waiting');
});

test('headlines restored from disk slot in by time, never twice, and gain their answer later', () => {
  const s = new DashboardState();
  s.apply(item('live', T0 + 5000));
  const restored = (id: string, recvTs: number, answered = false): NewsEntry => ({
    id, run: 0, source: 'wire', sourceLabel: 'A newswire', headline: id, url: null, publishedTs: null, recvTs, symbols: null,
    status: answered ? 'answered' : 'earlier',
    ...(answered ? { answer: { tResp: recvTs + 300, queueMs: 0, modelMs: 300, providerMs: null, costUsd: null, attempts: 1, novel: 0.5, verdicts: [], state: {} } } : {}),
  });
  s.apply(ev({ type: 'news-restored', program: 'news', entry: restored('old', T0) }));
  s.apply(ev({ type: 'news-restored', program: 'news', entry: restored('old', T0) }));
  assert.deepEqual(s.news.items.map(n => n.id), ['old', 'live']);
  assert.equal(s.news.lastRx, T0 + 5003, 'restoring from disk does not count as hearing from the pipeline');

  s.apply(ev({ type: 'news-outcome', program: 'news', id: 'old', recvTs: T0, symbol: 'BTC-USD', moves: { '60': 1 } }));
  s.apply(ev({ type: 'news-restored', program: 'news', entry: restored('old', T0, true) }));
  assert.equal(s.news.items[0]!.status, 'answered');
  assert.deepEqual(s.news.items[0]!.outcomes, { 'BTC-USD': { '60': 1 } }, 'what was already known about it is kept');
});
