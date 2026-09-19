import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bps, independentCount, mean, num, partialSpearman, quantile, ranks, spearman, summarize, tStat } from '../src/lib/stats.ts';

test('quantiles interpolate between neighbours', () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([10], 0.9), 10);
  assert.ok(Number.isNaN(quantile([], 0.5)));
  const s = summarize([5, 1, 3]);
  assert.deepEqual([s.n, s.min, s.p50, s.max, s.mean], [3, 1, 3, 5, 3]);
});

test('ties share their average rank', () => {
  assert.deepEqual(ranks([10, 20, 20, 30]), [0, 1.5, 1.5, 3]);
});

test('rank correlation: perfect, inverse, none, and unknowns skipped', () => {
  assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 400]), 1);
  assert.equal(spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1);
  assert.ok(Number.isNaN(spearman([1, 2], [1, 2])), 'too few points');
  assert.ok(Number.isNaN(spearman([1, 1, 1, 1], [1, 2, 3, 4])), 'a constant signal ranks nothing');
  assert.equal(spearman([1, 2, NaN, 3, 4], [1, 2, 99, 3, NaN]), 1);
});

test('missing is not zero: null from JSON must not become a number', () => {
  assert.ok(Number.isNaN(num(null)));
  assert.ok(Number.isNaN(num(undefined)));
  assert.ok(Number.isNaN(num('5')));
  assert.equal(num(0), 0);
  assert.ok(Number.isNaN(bps(null, 100)), 'an unfinished horizon is unknown, not a crash to zero');
  assert.ok(Number.isNaN(bps(100, null)));
  assert.ok(Math.abs(bps(101, 100) - 100) < 1e-9);
  assert.equal(mean([1, NaN, 3]), 2);
  assert.ok(Number.isNaN(mean([NaN])));
});

test('only decisions a full window apart count as separate evidence', () => {
  assert.equal(independentCount([], 1000), 0);
  assert.equal(independentCount([0, 100, 200, 300], 1000), 1, 'a burst is one observation');
  assert.equal(independentCount([0, 1000, 2000], 1000), 3);
  assert.equal(independentCount([0, 400, 800, 1200, 1600, 2000], 1000), 2, '0 and 1200; 2000 is only 800 after 1200');
  assert.equal(independentCount([300_000, 0, 100, 300_100], 1000), 2, 'two bursts, given out of order');
});

test('t grows with evidence and with the strength of the relationship', () => {
  assert.equal(tStat(0.5, 2), 0);
  assert.ok(tStat(0.2, 100) > 2);
  assert.ok(tStat(0.2, 10) < 1);
  assert.ok(tStat(-0.2, 100) < -2);
});

test('a signal that only repeats a simple rule knows nothing beyond it; one with its own information does', () => {
  // A seeded generator so the test is the same every run.
  let seed = 42;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32) - 0.5;
  const n = 400;
  const rule = Array.from({ length: n }, rand);
  const hidden = Array.from({ length: n }, rand); // something the rule cannot see
  const move = rule.map((r, i) => r + hidden[i]! + 0.2 * rand());
  const echo = rule.map(r => r + 0.05 * rand()); // repeats the rule
  const insight = rule.map((r, i) => r + hidden[i]!); // also sees the hidden part

  assert.ok(spearman(echo, move) > 0.5, 'on its own the echo looks good');
  assert.ok(Math.abs(partialSpearman(echo, move, [rule])) < 0.12, 'but it adds nothing to the rule');
  assert.ok(partialSpearman(insight, move, [rule]) > 0.8, 'real extra information survives');
  assert.ok(Number.isNaN(partialSpearman([1, 2, 3], [1, 2, 3], [[1, 2, 3]])), 'too few points');
  const flat = new Array<number>(n).fill(1);
  assert.ok(partialSpearman(insight, move, [rule, flat]) > 0.8, 'a rule that never varies is harmless');
});
