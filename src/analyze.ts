// Score decision logs from `live` or `backtest`.
//   1. Latency budget: where the time goes between an exchange event and a usable decision.
//   2. Signal quality per horizon: Jev vs zero-latency baselines, net of trading cost.
//   3. Latency decay: how much of the move happens while waiting for the model.
//   4. Calibration of Jev's direction probabilities.
//
//   npm run analyze -- data/decisions/<file>.jsonl [more files...]

import { readFileSync } from 'node:fs';
import { config } from './config.ts';
import type { DecisionRecord } from './engine.ts';
import { bps as bp, mean, spearman, summarize } from './lib/stats.ts';
import { DIRECTIONS } from './model/jev.ts';

const files = process.argv.slice(2);
if (files.length === 0) throw new Error('usage: npm run analyze -- <decisions.jsonl> [...]');
const recs: DecisionRecord[] = files.flatMap(f =>
  readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l)),
);
if (recs.length === 0) throw new Error('no decisions in input');

const fmt = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '-');
const pad = (s: string | number, n: number) => String(s).padStart(n);

console.log(`${recs.length} decisions from ${files.length} file(s); modes: ${[...new Set(recs.map(r => `${r.mode}/${r.provider}`))].join(', ')}`);
const spacing = summarize(recs.slice(1).map((r, i) => r.tState - recs[i]!.tState)).p50;
const spanS = (recs[recs.length - 1]!.tState - recs[0]!.tState) / 1000;
console.log(
  `${fmt(spanS / 60, 1)} min of decisions, median spacing ${fmt(spacing / 1000, 2)}s; round-trip cost hurdle ${config.feeBps}bp (FEE_BPS)\n`,
);

// ---- 1. latency budget --------------------------------------------------------
console.log('LATENCY BUDGET (ms)                 p50      p90      p99');
const row = (name: string, xs: number[], d = 1) => {
  const s = summarize(xs.filter(Number.isFinite));
  console.log(`  ${name.padEnd(32)} ${pad(fmt(s.p50, d), 7)}  ${pad(fmt(s.p90, d), 7)}  ${pad(fmt(s.p99, d), 7)}`);
};
row('age of newest data at decision', recs.map(r => r.exchLagMs));
row('features + encoding', recs.map(r => r.buildMs), 3);
row(`model round trip${recs[0]!.mode === 'backtest' ? ' (simulated)' : ''}`, recs.map(r => r.modelMs));
row('exchange event -> decision', recs.map(r => r.exchLagMs + r.buildMs + r.modelMs));
const tokens = summarize(recs.map(r => r.inputTokens ?? NaN).filter(Number.isFinite));
if (tokens.n) console.log(`  input tokens per decision p50 ${tokens.p50.toFixed(0)}`);
console.log('');

// ---- 2. signal quality ----------------------------------------------------------
type Score = { n: number; ic: number; t: number; hit: number; spread: number; edge: number };

function score(signal: number[], ret: number[], horizonS: number): Score {
  const pairs = signal.map((s, i) => [s, ret[i]!] as const).filter(([s, r]) => Number.isFinite(s) && Number.isFinite(r));
  const n = pairs.length;
  if (n < 10) return { n, ic: NaN, t: NaN, hit: NaN, spread: NaN, edge: NaN };
  const ic = spearman(pairs.map(p => p[0]), pairs.map(p => p[1]));
  // Decisions closer together than the horizon share their forward window, and features
  // look back ~5 s, so count independent windows rather than decisions.
  const nEff = Math.min(n, spanS / Math.max(horizonS, 5));
  const t = ic * Math.sqrt(Math.max(nEff - 2, 0) / Math.max(1 - ic * ic, 1e-9));
  const directional = pairs.filter(([s, r]) => s !== 0 && r !== 0);
  const hit = directional.filter(([s, r]) => Math.sign(s) === Math.sign(r)).length / directional.length;
  const sorted = [...pairs].sort((a, b) => a[0] - b[0]);
  const k = Math.max(1, Math.floor(n / 5));
  const meanRet = (xs: readonly (readonly [number, number])[]) => xs.reduce((a, p) => a + p[1], 0) / xs.length;
  const spread = meanRet(sorted.slice(n - k)) - meanRet(sorted.slice(0, k));
  // Long the top quintile, short the bottom, hold for the horizon: average return per trade.
  const edge = spread / 2 - config.feeBps;
  return { n, ic, t, hit, spread, edge };
}

const jevFor = Object.fromEntries(Object.entries(DIRECTIONS).map(([id, d]) => [d.seconds, `jev_${id.slice(4)}`]));
const baselines = ['obi1', 'obi5', 'flow5', 'mom5'];
const jevNames = Object.keys(recs[0]!.signals).filter(k => k.startsWith('jev_'));

console.log('SIGNAL QUALITY    Spearman IC with forward mid return; t counts independent windows (span / max(horizon, 5s))');
console.log('  jev_* scored from when the answer arrived (tradable); @state = from the snapshot (information only)');
console.log('  baselines are computed in microseconds, so they are scored from the snapshot');
console.log('  horizon  signal            n      IC      t   hit%  Q5-Q1bp  net edge bp');
for (const h of config.horizons) {
  const retResp = recs.map(r => bp(r.fwdResp[h], r.midResp));
  const retState = recs.map(r => bp(r.fwdState[h], r.midState));
  const oracle = mean(retState.map(Math.abs));
  console.log(`  ${pad(h + 's', 7)}  perfect foresight: mean |move| ${fmt(oracle, 2)}bp vs ${config.feeBps}bp cost`);
  const lines: [string, Score][] = [];
  for (const name of jevNames) lines.push([name, score(recs.map(r => r.signals[name]!), retResp, h)]);
  if (jevFor[h]) lines.push([`${jevFor[h]} @state`, score(recs.map(r => r.signals[jevFor[h]!]!), retState, h)]);
  for (const name of baselines) lines.push([name, score(recs.map(r => r.signals[name]!), retState, h)]);
  for (const [name, s] of lines) {
    console.log(
      `  ${pad(h + 's', 7)}  ${name.padEnd(15)} ${pad(s.n, 5)}  ${pad(fmt(s.ic, 3), 6)}  ${pad(fmt(s.t, 1), 5)}  ${pad(fmt(s.hit * 100, 0), 4)}  ${pad(fmt(s.spread, 2), 7)}  ${pad(fmt(s.edge, 2), 11)}`,
    );
  }
}
console.log('');

// ---- 3. latency decay -----------------------------------------------------------
console.log('LATENCY DECAY    what moved while the model was thinking');
const during = recs.map(r => bp(r.midResp, r.midState));
console.log(`  |mid move| during model call: mean ${fmt(mean(during.map(Math.abs)), 3)}bp`);
for (const name of jevNames) {
  const ic = spearman(recs.map(r => r.signals[name]!), during);
  console.log(`  ${name.padEnd(8)} IC with the move that already happened before the answer arrived: ${fmt(ic, 3)}`);
}
console.log('');

// ---- 4. calibration -------------------------------------------------------------
console.log('CALIBRATION    predicted P(up)/P(down) vs realized frequency, from the snapshot');
for (const [id, d] of Object.entries(DIRECTIONS)) {
  const bins = Array.from({ length: 5 }, () => ({ n: 0, p: 0, hits: 0 }));
  for (const r of recs) {
    const p = r.probabilities[id as keyof typeof DIRECTIONS];
    const ret = bp(r.fwdState[d.seconds], r.midState);
    if (!p || !Number.isFinite(ret)) continue;
    for (const [outcome, happened] of [
      ['up', ret > d.flatBps],
      ['down', ret < -d.flatBps],
    ] as const) {
      const prob = p[outcome] ?? 0;
      const b = bins[Math.min(4, Math.floor(prob * 5))]!;
      b.n++;
      b.p += prob;
      b.hits += happened ? 1 : 0;
    }
  }
  const cells = bins.map((b, i) => `${(i / 5).toFixed(1)}-${((i + 1) / 5).toFixed(1)}: ${b.n ? `${fmt(b.p / b.n)}→${fmt(b.hits / b.n)} (n${b.n})` : '-'}`);
  console.log(`  ${id.padEnd(8)} ${cells.join('  ')}`);
}
