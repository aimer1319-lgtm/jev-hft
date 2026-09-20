import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pnlReport } from '../src/dashboard/pnl.ts';
import type { DecisionRecord } from '../src/engine.ts';
import type { NewsRecord } from '../src/news/engine.ts';

const T0 = 1_800_000_000_000;
const OPTS = { feeBps: 0, notionalUsd: 10_000, product: 'BTC-USD' };

type Extra = { rules?: Partial<Record<'obi1' | 'obi5' | 'flow5' | 'mom5', number>>; confidence?: number };

/** A finished decision: Jev leaned `jev`, and the price then moved `moveBp` over every horizon. */
function decision(i: number, moveBp: number, jev: number, extra: Extra = {}): DecisionRecord {
  const later = 100 * (1 + moveBp / 1e4);
  const fwd = { 1: later, 2: later, 5: later, 10: later, 30: later, 60: later };
  const rules = { obi1: 0, obi5: 0, flow5: 0, mom5: 0, ...extra.rules };
  return {
    v: 2, mode: 'live', provider: 'test', tState: T0 + i * 1000, exchLagMs: 90, buildMs: 0.3, modelMs: 260, tResp: T0 + i * 1000 + 260, state: '',
    probabilities: {} as DecisionRecord['probabilities'],
    ...(extra.confidence !== undefined ? { confidence: { dir_2s: extra.confidence, dir_10s: extra.confidence, dir_60s: extra.confidence } } : {}),
    signals: { jev_2s: jev, jev_10s: jev, jev_60s: jev, ...rules },
    midState: 100, midResp: 100, fwdState: fwd, fwdResp: fwd,
  };
}

function newsRecord(over: Partial<NewsRecord> = {}): NewsRecord {
  return {
    v: 2, kind: 'news', provider: 'test',
    item: { id: 'wire:1', source: 'wire', sourceLabel: 'A newswire', headline: 'BTC ETF inflows surge', recvTs: T0, symbols: ['BTC-USD'] },
    symbol: 'BTC-USD', assetClass: 'crypto', session: 'regular', tracked: true, spreadBps: 1, queueMs: 5, prepareMs: 50, attempts: 1,
    tState: T0, buildMs: 0.2, modelMs: 290, tResp: T0, instruments: 1, state: {} as NewsRecord['state'],
    relevant: 0.9, direction: { bullish: 0.8, bearish: 0.1, neutral: 0.1 }, magnitude: 2, magnitudeProbs: {}, novel: 0.7, signal: 0.7,
    midPublished: NaN, midRecv: 100, midResp: 100, fwdRecv: {}, fwdResp: {},
    ...over,
  };
}

const baseline = (recs: DecisionRecord[], horizonS = 10, opts = OPTS) => pnlReport(recs, opts).baseline.legs.find(l => l.horizonS === horizonS)!;
const filtered = (recs: DecisionRecord[], horizonS = 10, opts = OPTS, news: NewsRecord[] = []) => pnlReport(recs, opts, news).filtered.legs.find(l => l.horizonS === horizonS)!;

// ---- baseline: every lean, one size (unchanged behaviour) --------------------------------------

test('baseline: a right call earns the move and a wrong one pays it', () => {
  const l = baseline([decision(0, 4, 1), decision(1, -6, -1), decision(2, 5, -1)]);
  assert.equal(l.trades, 3);
  assert.equal(l.wins, 2);
  assert.equal(l.losses, 1);
  assert.ok(Math.abs(l.totalBps - (4 + 6 - 5)) < 1e-9);
  assert.ok(Math.abs(l.avgBps! - 5 / 3) < 1e-9);
  assert.ok(Math.abs(l.bestBps! - 6) < 1e-9);
  assert.ok(Math.abs(l.worstBps! - -5) < 1e-9);
});

test('baseline: no lean means no trade, and a flat market is a trade that made nothing', () => {
  const l = baseline([decision(0, 7, 0), decision(1, 0, 1)]);
  assert.equal(l.trades, 1, 'the answer with no lean sat out');
  assert.equal(l.wins, 0);
  assert.equal(l.losses, 0, 'a price that did not move is not a loss');
  assert.equal(l.totalBps, 0);
});

test('baseline: a horizon whose price is not known yet is left out', () => {
  const rec = decision(0, 4, 1);
  rec.fwdResp[10] = null as unknown as number; // how an unfinished horizon comes back from a file
  assert.equal(baseline([rec]).trades, 0);
  assert.equal(baseline([rec], 60).trades, 1, 'the horizons that did finish still count');
});

test('baseline: the cost is charged to both ends of every trade', () => {
  const recs = [decision(0, 4, 1), decision(1, 4, 1)];
  assert.ok(Math.abs(baseline(recs).totalBps - 8) < 1e-9);
  const charged = baseline(recs, 10, { ...OPTS, feeBps: 3 });
  assert.ok(Math.abs(charged.totalBps - 2) < 1e-9, 'two trades, three basis points each');
  assert.equal(charged.wins, 2, 'each one still finished above water');
  assert.equal(baseline(recs, 10, { ...OPTS, feeBps: 5 }).wins, 0, 'a cost above the move sinks them');
  assert.equal(baseline([decision(0, 0, 1)], 10, { ...OPTS, feeBps: 2 }).losses, 1, 'once there is a cost, going nowhere loses');
});

test('baseline: the worst dip is measured from the best point reached, not from the start', () => {
  // Up 10, down 6, down 2, up 1: the running total peaks at 10 and falls to 2.
  const l = baseline([decision(0, 10, 1), decision(1, -6, 1), decision(2, -2, 1), decision(3, 1, 1)]);
  assert.ok(Math.abs(l.totalBps - 3) < 1e-9);
  assert.ok(Math.abs(l.maxDrawdownBps - 8) < 1e-9);
});

test('baseline: the curve is the running total, and stays small enough to send often', () => {
  const many = Array.from({ length: 900 }, (_, i) => decision(i, 1, 1));
  const l = baseline(many);
  assert.equal(l.trades, 900);
  assert.ok(l.curve.length <= 240, `thinned to ${l.curve.length}`);
  assert.equal(l.curve[0]!.t, many[0]!.tResp, 'starts at the first trade');
  assert.ok(Math.abs(l.curve.at(-1)!.cumBps - 900) < 1e-9, 'ends at the total');
});

test('nothing to report is reported as nothing, not as zero profit', () => {
  const set = pnlReport([], OPTS);
  for (const report of [set.baseline, set.filtered]) {
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
  }
});

// ---- filtered: technical confluence -------------------------------------------------------------

test('filtered: sits out unless a technical rule agrees with the lean', () => {
  const disagree = decision(0, 5, 1, { rules: { obi1: -1, obi5: -1, flow5: -1, mom5: -1 } });
  assert.equal(filtered([disagree]).trades, 0);
  const oneAgrees = decision(0, 5, 1, { rules: { obi1: 1, obi5: -1, flow5: -1, mom5: -1 } });
  assert.equal(filtered([oneAgrees]).trades, 1, 'one rule agreeing is enough');
  const allNeutral = decision(0, 5, 1); // rules default to 0
  assert.equal(filtered([allNeutral]).trades, 0, 'a rule with no opinion does not count as agreeing');
});

test('filtered: still needs a lean and a known price, same as baseline', () => {
  const noLean = decision(0, 5, 0, { rules: { obi1: 1 } });
  assert.equal(filtered([noLean]).trades, 0);
});

// ---- filtered: sizing by strength and confidence -------------------------------------------------

test('filtered: sizes by how strong the lean was and how sure TypeSafe reported being', () => {
  const rec = decision(0, 8, 0.5, { rules: { obi1: 1 }, confidence: 0.5 });
  const l = filtered([rec]);
  assert.equal(l.trades, 1);
  assert.ok(Math.abs(l.totalBps - 8 * 0.5 * 0.5) < 1e-9, `expected a quarter-size trade, got ${l.totalBps}`);
});

test('filtered: a missing confidence sizes by the lean alone, not zero', () => {
  const rec = decision(0, 8, 0.5, { rules: { obi1: 1 } }); // no confidence field at all
  const l = filtered([rec]);
  assert.ok(Math.abs(l.totalBps - 8 * 0.5) < 1e-9);
});

test('filtered: full lean and full confidence is one full-size trade, not larger', () => {
  const rec = decision(0, 8, 1, { rules: { obi1: 1 }, confidence: 1 });
  const l = filtered([rec]);
  assert.ok(Math.abs(l.totalBps - 8) < 1e-9);
});

test("filtered: bestBps and worstBps describe the call, not the stake it was given", () => {
  // A weak, small-stake win next to a strong, full-stake loss: the win must not look "best" just for being smaller.
  const recs = [decision(0, 8, 0.2, { rules: { obi1: 1 }, confidence: 0.5 }), decision(1, -8, 1, { rules: { obi1: 1 }, confidence: 1 })];
  const l = filtered(recs);
  assert.ok(Math.abs(l.bestBps! - 8) < 1e-9, 'the +8bp call was the best, regardless of its stake');
  assert.ok(Math.abs(l.worstBps! - -8) < 1e-9);
});

// ---- filtered: a recent headline ----------------------------------------------------------------

test('filtered: sits out when a recent headline leans the other way', () => {
  const rec = decision(0, 5, 1, { rules: { obi1: 1 } });
  const news = [newsRecord({ tResp: rec.tState - 60_000, signal: -0.8 })];
  assert.equal(filtered([rec], 10, OPTS, news).trades, 0);
});

test('filtered: a headline older than the lookback window no longer counts', () => {
  const rec = decision(0, 5, 1, { rules: { obi1: 1 } });
  const news = [newsRecord({ tResp: rec.tState - 20 * 60_000, signal: -0.8 })]; // 20 minutes old
  assert.equal(filtered([rec], 10, OPTS, news).trades, 1, 'too old to still apply, so the trade goes through');
});

test('filtered: sizes up a little when a recent headline agrees', () => {
  const rec = decision(0, 8, 1, { rules: { obi1: 1 }, confidence: 1 });
  const withoutNews = filtered([rec]);
  const withNews = filtered([rec], 10, OPTS, [newsRecord({ tResp: rec.tState - 60_000, signal: 0.7 })]);
  assert.ok(withNews.totalBps > withoutNews.totalBps, 'agreeing news should trade a bit bigger');
  assert.ok(Math.abs(withNews.totalBps - 8 * 1.25) < 1e-9, 'a fixed, modest boost, not an unbounded one');
});

test('filtered: never uses a headline that arrived after the decision (no lookahead)', () => {
  const rec = decision(0, 5, 1, { rules: { obi1: 1 } });
  const future = newsRecord({ tResp: rec.tState + 1, signal: -0.9 }); // one ms after the snapshot: not yet known
  assert.equal(filtered([rec], 10, OPTS, [future]).trades, 1, 'a headline from the future must not veto a real trade');
});

test('filtered: a headline about a different instrument has no say over this one', () => {
  const rec = decision(0, 5, 1, { rules: { obi1: 1 } });
  const news = [newsRecord({ tResp: rec.tState - 60_000, signal: -0.9, symbol: 'AAPL' })];
  assert.equal(filtered([rec], 10, OPTS, news).trades, 1, 'a headline about AAPL says nothing about BTC-USD');
});
