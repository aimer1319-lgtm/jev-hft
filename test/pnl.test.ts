import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pnlReport } from '../src/dashboard/pnl.ts';
import type { DecisionRecord } from '../src/engine.ts';

const T0 = 1_800_000_000_000;
const OPTS = { feeBps: 0, notionalUsd: 10_000 };

/** A finished decision: Jev leaned `jev`, and the price then moved `moveBp` over every horizon. */
function decision(i: number, moveBp: number, jev: number): DecisionRecord {
  const later = 100 * (1 + moveBp / 1e4);
  const fwd = { 1: later, 2: later, 5: later, 10: later, 30: later, 60: later };
  return {
    v: 2, mode: 'live', provider: 'test', tState: T0 + i * 1000, exchLagMs: 90, buildMs: 0.3, modelMs: 260, tResp: T0 + i * 1000 + 260, state: '',
    probabilities: {} as DecisionRecord['probabilities'],
    signals: { jev_2s: jev, jev_10s: jev, jev_60s: jev },
    midState: 100, midResp: 100, fwdState: fwd, fwdResp: fwd,
  };
}

const leg = (recs: DecisionRecord[], horizonS = 10, opts = OPTS) => pnlReport(recs, opts).legs.find(l => l.horizonS === horizonS)!;

test('a right call earns the move and a wrong one pays it', () => {
  const l = leg([decision(0, 4, 1), decision(1, -6, -1), decision(2, 5, -1)]);
  assert.equal(l.trades, 3);
  assert.equal(l.wins, 2);
  assert.equal(l.losses, 1);
  assert.ok(Math.abs(l.totalBps - (4 + 6 - 5)) < 1e-9);
  assert.ok(Math.abs(l.avgBps! - 5 / 3) < 1e-9);
  assert.ok(Math.abs(l.bestBps! - 6) < 1e-9);
  assert.ok(Math.abs(l.worstBps! - -5) < 1e-9);
});

test('no lean means no trade, and a flat market is a trade that made nothing', () => {
  const l = leg([decision(0, 7, 0), decision(1, 0, 1)]);
  assert.equal(l.trades, 1, 'the answer with no lean sat out');
  assert.equal(l.wins, 0);
  assert.equal(l.losses, 0, 'a price that did not move is not a loss');
  assert.equal(l.totalBps, 0);
});

test('a horizon whose price is not known yet is left out', () => {
  const rec = decision(0, 4, 1);
  rec.fwdResp[10] = null as unknown as number; // how an unfinished horizon comes back from a file
  assert.equal(leg([rec]).trades, 0);
  assert.equal(leg([rec], 60).trades, 1, 'the horizons that did finish still count');
});

test('the cost is charged to both ends of every trade', () => {
  const recs = [decision(0, 4, 1), decision(1, 4, 1)];
  assert.ok(Math.abs(leg(recs).totalBps - 8) < 1e-9);
  const charged = leg(recs, 10, { ...OPTS, feeBps: 3 });
  assert.ok(Math.abs(charged.totalBps - 2) < 1e-9, 'two trades, three basis points each');
  assert.equal(charged.wins, 2, 'each one still finished above water');
  assert.equal(leg(recs, 10, { ...OPTS, feeBps: 5 }).wins, 0, 'a cost above the move sinks them');
  assert.equal(leg([decision(0, 0, 1)], 10, { ...OPTS, feeBps: 2 }).losses, 1, 'once there is a cost, going nowhere loses');
});

test('the worst dip is measured from the best point reached, not from the start', () => {
  // Up 10, down 6, down 2, up 1: the running total peaks at 10 and falls to 2.
  const l = leg([decision(0, 10, 1), decision(1, -6, 1), decision(2, -2, 1), decision(3, 1, 1)]);
  assert.ok(Math.abs(l.totalBps - 3) < 1e-9);
  assert.ok(Math.abs(l.maxDrawdownBps - 8) < 1e-9);
});

test('the curve is the running total, and stays small enough to send often', () => {
  const many = Array.from({ length: 900 }, (_, i) => decision(i, 1, 1));
  const l = leg(many);
  assert.equal(l.trades, 900);
  assert.ok(l.curve.length <= 240, `thinned to ${l.curve.length}`);
  assert.equal(l.curve[0]!.t, many[0]!.tResp, 'starts at the first trade');
  assert.ok(Math.abs(l.curve.at(-1)!.cumBps - 900) < 1e-9, 'ends at the total');
});

test('nothing to report is reported as nothing, not as zero profit', () => {
  const report = pnlReport([], OPTS);
  assert.equal(report.n, 0);
  assert.equal(report.since, null);
  assert.deepEqual(
    report.legs.map(l => l.horizonS),
    [2, 10, 60],
  );
  for (const l of report.legs) {
    assert.equal(l.trades, 0);
    assert.equal(l.avgBps, null);
    assert.equal(l.bestBps, null);
    assert.deepEqual(l.curve, []);
  }
});
