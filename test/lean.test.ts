import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DecisionRecord } from '../src/engine.ts';
import { conviction, correctedLean, fillLeans, LEAN_MIN_ANSWERS, LEAN_WINDOW_MS, LeanBook, LeanTracker } from '../src/model/lean.ts';

const T0 = 1_800_000_000_000;
const near = (a: number, b: number, what?: string) => assert.ok(Math.abs(a - b) < 1e-9, what ?? `${a} is not ${b}`);

test('the usual lean is the middle of the earlier answers, and "typical" is how far they stray from it', () => {
  const t = new LeanTracker(60_000, 3);
  [-0.5, -0.3, -0.1, 0.4].forEach((x, i) => t.push(T0 + i * 1000, x));
  const r = t.read(T0 + 4000);
  near(r.usual, -0.2, 'an even count takes the midpoint of the middle two');
  near(r.typical, (0.3 + 0.1 + 0.1 + 0.6) / 4);
  t.push(T0 + 4000, -0.4);
  near(t.read(T0 + 5000).usual, -0.3, 'an odd count takes the middle one');
});

test('it is unknown until there are enough earlier answers', () => {
  const t = new LeanTracker(60_000, 3);
  t.push(T0, -0.3);
  t.push(T0 + 1000, -0.2);
  assert.ok(Number.isNaN(t.read(T0 + 2000).usual));
  assert.ok(Number.isNaN(t.read(T0 + 2000).typical));
  t.push(T0 + 2000, -0.1);
  near(t.read(T0 + 3000).usual, -0.2);
});

test('answers older than the window stop counting, including repeats of the same value', () => {
  const t = new LeanTracker(10_000, 2);
  t.push(T0, -0.9);
  t.push(T0 + 1000, -0.9); // the same value twice: removing one must leave the other
  t.push(T0 + 9000, 0.1);
  t.push(T0 + 9500, 0.3);
  near(t.read(T0 + 10_000).usual, (-0.9 + 0.1) / 2, 'all four still count');
  near(t.read(T0 + 10_500).usual, 0.1, 'the first -0.9 has gone, the second has not');
  near(t.read(T0 + 12_000).usual, 0.2, 'both have gone');
  assert.ok(Number.isNaN(t.read(T0 + 60_000).usual), 'and after a long silence nothing is known again');
});

test('a value that is not a number is ignored rather than poisoning the middle', () => {
  const t = new LeanTracker(60_000, 2);
  t.push(T0, -0.4);
  t.push(T0 + 1, NaN);
  t.push(T0 + 2, -0.2);
  near(t.read(T0 + 3).usual, -0.3);
});

test('a lean is corrected by taking the usual lean out, and its strength is judged against the typical one', () => {
  const reading = { usual: -0.3, typical: 0.2 };
  near(correctedLean(-0.1, reading), 0.2, '"a little less down than usual" is a lean up');
  near(conviction(0.2, reading), 1, 'an ordinary lean');
  near(conviction(-0.5, reading), 2.5);
  assert.equal(conviction(0, reading), 0);
  assert.ok(Number.isNaN(correctedLean(-0.1, { usual: NaN, typical: NaN })), 'unknown usual lean, unknown corrected lean');
  assert.ok(Number.isNaN(conviction(0.2, undefined)));
  assert.equal(conviction(0.2, { usual: -0.3, typical: 0 }), Infinity, 'every earlier answer was identical, so any departure is as strong as can be');
});

const answer = (up: number, down: number) => ({ up, down, flat: 1 - up - down });

test('an answer is read against the answers before it, never against itself (no lookahead)', () => {
  const book = new LeanBook(60_000, 2);
  const steady = { dir_2s: answer(0.1, 0.4), dir_10s: answer(0.1, 0.4), dir_60s: answer(0.1, 0.4) };
  book.take(T0, steady);
  book.take(T0 + 1000, steady);
  // Two answers of -0.3 so far. This one is far from them; if it counted towards its own
  // "usual", the middle would move towards it and its corrected lean would shrink.
  const odd = { dir_2s: answer(0.9, 0), dir_10s: answer(0.9, 0), dir_60s: answer(0.9, 0) };
  const read = book.take(T0 + 2000, odd);
  near(read.lean.dir_10s.usual, -0.3, 'the usual lean is that of the two earlier answers only');
  near(read.signals.jevc_10s!, 0.9 - -0.3);
  const next = book.take(T0 + 3000, steady);
  near(next.lean.dir_10s.usual, -0.3, 'and only now does the odd one count (middle of -0.3, -0.3, 0.9)');
});

test('each question keeps its own usual lean', () => {
  const book = new LeanBook(60_000, 2);
  const a = { dir_2s: answer(0, 0.2), dir_10s: answer(0, 0.5), dir_60s: answer(0.3, 0) };
  book.take(T0, a);
  book.take(T0 + 1000, a);
  const read = book.take(T0 + 2000, a);
  near(read.lean.dir_2s.usual, -0.2);
  near(read.lean.dir_10s.usual, -0.5);
  near(read.lean.dir_60s.usual, 0.3);
  near(read.signals.jevc_2s!, 0);
  assert.deepEqual(Object.keys(read.signals).sort(), ['jevc_10s', 'jevc_2s', 'jevc_60s']);
});

function record(i: number, lean: number): DecisionRecord {
  const p = lean >= 0 ? answer(lean, 0) : answer(0, -lean);
  return {
    v: 2, mode: 'live', provider: 'test', tState: T0 + i * 1000, exchLagMs: 90, buildMs: 0.3, modelMs: 260, tResp: T0 + i * 1000 + 260, state: '',
    probabilities: { dir_2s: p, dir_10s: p, dir_60s: p },
    signals: { jev_2s: lean, jev_10s: lean, jev_60s: lean, obi1: 0, obi5: 0, flow5: 0, mom5: 0 },
    midState: 100, midResp: 100, fwdState: {}, fwdResp: {},
  };
}

test('older records are given the reading a live run would have made, and a reading already there is kept', () => {
  const recs = Array.from({ length: LEAN_MIN_ANSWERS + 3 }, (_, i) => record(i, -0.3));
  recs[recs.length - 1] = record(recs.length - 1, 0.1);
  const kept = { dir_2s: { usual: 9, typical: 9 }, dir_10s: { usual: 9, typical: 9 }, dir_60s: { usual: 9, typical: 9 } };
  recs[recs.length - 2]!.lean = kept;
  fillLeans(recs);
  assert.ok(Number.isNaN(recs[0]!.signals.jevc_10s), 'nothing to read the first answer against');
  assert.ok(Number.isNaN(recs[LEAN_MIN_ANSWERS - 1]!.signals.jevc_10s), 'one short of enough');
  near(recs[LEAN_MIN_ANSWERS]!.signals.jevc_10s!, 0, 'the same as every answer before it: no lean at all');
  assert.equal(recs[recs.length - 2]!.lean, kept, 'the pipeline had already read this one, so it is left alone');
  assert.equal(recs[recs.length - 2]!.signals.jevc_10s, undefined);
  near(recs[recs.length - 1]!.signals.jevc_10s!, 0.4, '+0.1 against a usual -0.3');
  near(recs[recs.length - 1]!.lean!.dir_10s.usual, -0.3);
});

test('filling in batches, as the dashboard does while a run goes on, gives the same as all at once', () => {
  const leans = Array.from({ length: 200 }, (_, i) => Math.sin(i / 7) * 0.5 - 0.3);
  const whole = fillLeans(leans.map((x, i) => record(i, x)));
  const book = new LeanBook();
  const parts = leans.map((x, i) => record(i, x));
  fillLeans(parts.slice(0, 70), book);
  fillLeans(parts.slice(70, 71), book);
  fillLeans(parts.slice(71), book);
  assert.deepEqual(parts.map(r => r.signals.jevc_10s), whole.map(r => r.signals.jevc_10s));
});

test('the window is a quarter of an hour, and a minute of answers is enough to start', () => {
  assert.equal(LEAN_WINDOW_MS, 15 * 60_000);
  assert.equal(LEAN_MIN_ANSWERS, 60);
});
