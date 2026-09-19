import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { config } from '../src/config.ts';
import { LiveEngine, type DecisionRecord } from '../src/engine.ts';
import { nowMs, type MarketEvent } from '../src/feed/types.ts';
import { scriptedModel, settle, type Step } from './helpers.ts';

const defaults = { warmupMs: config.warmupMs, minIntervalMs: config.minIntervalMs, maxInFlight: config.maxInFlight, flatSigmas: config.flatSigmas };
afterEach(() => Object.assign(config, defaults));

// Every event replaces the whole book, so the mid is exactly what the test says.
const book = (t: number, mid: number, _first = false): MarketEvent => ({
  type: 'book',
  snapshot: true,
  updates: [
    { side: 'bid', price: mid - 0.5, size: 2 },
    { side: 'ask', price: mid + 0.5, size: 1 },
  ],
  exchTs: t - 40,
  recvTs: t,
});

function setup(script: Step[] = []) {
  const { model, calls } = scriptedModel(script);
  const written: DecisionRecord[] = [];
  const logs: string[] = [];
  const engine = new LiveEngine(model, r => written.push(r), s => logs.push(s));
  return { engine, calls, written, logs };
}

test('no question is asked until the history windows have had time to fill', async () => {
  Object.assign(config, { warmupMs: 60_000, minIntervalMs: 0 });
  const s = setup();
  const t = nowMs();
  s.engine.onEvent(book(t, 100, true));
  s.engine.onEvent(book(t + 59_000, 100));
  await settle();
  assert.equal(s.calls.length, 0);
  s.engine.onEvent(book(t + 60_000, 100));
  await settle();
  assert.equal(s.calls.length, 1);
});

test('a decision is recorded with what was asked, what was answered, simple rules, and later prices', async () => {
  Object.assign(config, { warmupMs: 0, minIntervalMs: 3_600_000 });
  const s = setup();
  const t = nowMs();
  s.engine.onEvent(book(t, 100, true));
  await settle();
  assert.equal(s.calls.length, 1);
  assert.equal(s.written.length, 0, 'held until its last horizon');
  s.engine.onEvent(book(t + 30_000, 101));
  s.engine.onEvent(book(t + 59_000, 102));
  assert.equal(s.written.length, 0);
  s.engine.onEvent(book(t + 61_000, 103));
  assert.equal(s.written.length, 1);
  const r = s.written[0]!;
  assert.equal(r.v, 2);
  assert.equal(r.mode, 'live');
  assert.deepEqual(r.flatBps, { dir_2s: 0.5, dir_10s: 1, dir_60s: 3 }, 'volatility is not known yet, so the fixed thresholds were asked');
  assert.deepEqual(r.probabilities.dir_10s, { up: 0.8, down: 0.1, flat: 0.1 });
  assert.ok(Math.abs(r.signals.jev_10s! - 0.7) < 1e-12);
  assert.ok(Math.abs(r.signals.obi1! - 1 / 3) < 1e-12, 'book imbalance: (2 - 1) / (2 + 1)');
  assert.equal(r.midState, 100);
  assert.equal(r.fwdResp[1], 100);
  assert.equal(r.fwdState[30], 101, 'the price 30 s after the snapshot');
  assert.equal(r.fwdState[60], 102, 'the last price known by then (the move to 103 came at 61 s)');
  assert.ok(r.tResp >= r.tState);
  assert.equal(r.costUsd, 0.000025);
  assert.equal(r.providerMs, 120);
  assert.match(r.state, /^BTC-USD \d\d:\d\d UTC mid 100\.00/);
});

test('decisions keep their spacing, and one at a time', async () => {
  Object.assign(config, { warmupMs: 0, minIntervalMs: 1000 });
  const s = setup();
  const t = nowMs();
  s.engine.onEvent(book(t, 100, true));
  await settle();
  s.engine.onEvent(book(t + 100, 100));
  s.engine.onEvent(book(t + 900, 100));
  await settle();
  assert.equal(s.calls.length, 1);
  s.engine.onEvent(book(t + 1000, 100));
  await settle();
  assert.equal(s.calls.length, 2);
});

test('after a rate-limit refusal the loop pauses instead of hammering', async () => {
  Object.assign(config, { warmupMs: 0, minIntervalMs: 0 });
  const s = setup(['rate-limit']);
  const t = nowMs();
  s.engine.onEvent(book(t, 100, true));
  await settle();
  s.engine.onEvent(book(t + 1000, 100));
  await settle();
  assert.equal(s.calls.length, 1);
  assert.equal(s.engine.stats.rateLimited, 1);
  assert.match(s.logs.join('\n'), /pausing decisions 5s/);
});

test('a broken feed stops decisions until the book is rebuilt and warmed up again', async () => {
  Object.assign(config, { warmupMs: 10_000, minIntervalMs: 0 });
  const s = setup();
  const t = nowMs();
  s.engine.onEvent(book(t, 100, true));
  s.engine.onEvent({ type: 'reset', recvTs: t + 5000 });
  s.engine.onEvent(book(t + 6000, 100, true));
  s.engine.onEvent(book(t + 15_000, 100));
  await settle();
  assert.equal(s.calls.length, 0, 'only 9 s since the book came back');
  s.engine.onEvent(book(t + 16_000, 100));
  await settle();
  assert.equal(s.calls.length, 1);
});
