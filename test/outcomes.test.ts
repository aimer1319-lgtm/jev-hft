import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveOutcome, newsOutcome, restoredEntry, scoreboard } from '../src/dashboard/outcomes.ts';
import type { DecisionRecord } from '../src/engine.ts';
import type { NewsRecord } from '../src/news/engine.ts';

const T0 = 1_800_000_000_000;

/** A finished decision: the price moved `moveBp` over every horizon; Jev and one rule each said something. */
function decision(i: number, moveBp: number, jev: number, rule: number): DecisionRecord {
  const later = 100 * (1 + moveBp / 1e4);
  const fwd = { 1: later, 2: later, 5: later, 10: later, 30: later, 60: later };
  return {
    v: 2, mode: 'live', provider: 'test', tState: T0 + i * 1000, exchLagMs: 90, buildMs: 0.3, modelMs: 260, tResp: T0 + i * 1000 + 260, state: '',
    probabilities: {} as DecisionRecord['probabilities'],
    signals: { jev_2s: jev, jev_10s: jev, jev_60s: jev, obi1: rule, obi5: 0, flow5: 0, mom5: 0 },
    midState: 100, midResp: 100, fwdState: fwd, fwdResp: fwd,
  };
}

test('what happened after a decision, in basis points, with unknown kept unknown', () => {
  const rec = decision(0, 5, 1, 1);
  rec.fwdResp[60] = null as unknown as number; // how an unfinished horizon comes back from a file
  const o = liveOutcome(rec);
  assert.ok(Math.abs(o.fromState['10']! - 5) < 1e-9);
  assert.equal(o.fromResp['60'], null, 'not zero');
  assert.equal(o.tState, rec.tState);
});

test('the scoreboard counts who pointed the right way, and only where there was a direction to get right', () => {
  const recs = [
    ...Array.from({ length: 30 }, (_, i) => decision(i, i % 2 ? 2 + i / 10 : -2 - i / 10, i % 2 ? 0.8 : -0.8, i % 2 ? -0.5 : 0.5)), // Jev right, the rule wrong
    ...Array.from({ length: 10 }, (_, i) => decision(100 + i, 0, 0.9, 0.9)), // the price did not move: nothing to judge
  ];
  const board = scoreboard(recs);
  assert.equal(board.n, 40);
  assert.deepEqual(board.horizons, [2, 10, 60]);
  const jev = board.rows.find(r => r.isJev)!.cells[1]!;
  const rule = board.rows.find(r => r.key === 'obi1')!.cells[1]!;
  assert.deepEqual([jev.hit, jev.judged, jev.n], [1, 30, 40]);
  assert.deepEqual([rule.hit, rule.judged], [0, 30]);
  assert.ok(jev.ic! > 0.5 && rule.ic! < -0.5);
  const silent = board.rows.find(r => r.key === 'mom5')!.cells[1]!;
  assert.deepEqual([silent.hit, silent.judged], [null, 0], 'a rule that never leaned has no score');
});

test('a Jev that only repeats a rule has nothing left once the rule is accounted for', () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32) - 0.5;
  const recs = Array.from({ length: 300 }, (_, i) => {
    const rule = rand();
    return decision(i, rule * 4 + rand(), rule + rand() * 0.02, rule);
  });
  const board = scoreboard(recs);
  assert.ok(board.rows.find(r => r.isJev)!.cells[1]!.ic! > 0.8, 'on its own it looks excellent');
  assert.ok(Math.abs(board.beyond[1]!.ic!) < 0.15, 'but it adds nothing');
});

function newsRecord(over: Partial<NewsRecord> = {}): NewsRecord {
  return {
    v: 2, kind: 'news', provider: 'test',
    item: { id: 'wire:1', source: 'wire', sourceLabel: 'A newswire', headline: 'Apple raises guidance', recvTs: T0, symbols: ['AAPL'] },
    symbol: 'AAPL', assetClass: 'equity', session: 'regular', tracked: true, spreadBps: 3, queueMs: 5, prepareMs: 200, attempts: 1,
    tState: T0 + 205, buildMs: 0.2, modelMs: 290, tResp: T0 + 495, instruments: 1, state: {} as NewsRecord['state'],
    relevant: 0.9, direction: { bullish: 0.8, bearish: 0.1, neutral: 0.1 }, magnitude: 2, magnitudeProbs: {}, novel: 0.7, signal: 0.63,
    midPublished: NaN, midRecv: 200, midResp: 200, fwdRecv: {}, fwdResp: { 60: 200.4, 300: 201 }, fwdSpreadBps: { 60: 3, 300: 400 },
    ...over,
  };
}

test('a news outcome only counts a move with a usable price at both ends', () => {
  const o = newsOutcome(newsRecord(), 50);
  assert.ok(Math.abs(o.moves['60']! - 20) < 1e-6);
  assert.equal(o.moves['300'], null, 'the quote at the 5-minute check was 400 bp wide');
  assert.deepEqual([o.id, o.recvTs, o.symbol], ['wire:1', T0, 'AAPL']);
  assert.equal(newsOutcome(newsRecord({ session: 'closed' }), 50).moves['60'], null);
});

test('a headline restored from disk carries Jev\'s answer only if a finished record exists', () => {
  const rec = newsRecord();
  const without = restoredEntry(rec.item, []);
  assert.deepEqual([without.status, without.answer, without.sourceLabel], ['earlier', undefined, 'A newswire']);
  const withAnswer = restoredEntry(rec.item, [rec, newsRecord({ symbol: 'SPY' })]);
  assert.equal(withAnswer.status, 'answered');
  assert.deepEqual(withAnswer.answer!.verdicts.map(v => v.symbol), ['AAPL', 'SPY']);
  assert.equal(withAnswer.answer!.novel, 0.7);
});
