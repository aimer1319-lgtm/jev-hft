// What trading on Jev's answers would have made.
//
// The rule is the simplest one that could actually have been followed at the time: when Jev
// leans a way, take that side at the price its answer arrived at, hold for the horizon, close at
// the mid. Every lean is traded, all the same size.
//
// Nothing here looks at how the run turned out before deciding what to trade, which is the
// difference between this and the "net edge" in the report (src/analyze.ts): that one sorts the
// whole run into quintiles to find its strongest signals, and you could only do that afterwards.

import type { DecisionRecord } from '../engine.ts';
import { bps } from '../lib/stats.ts';
import { DIRECTIONS } from '../model/jev.ts';
import type { Pnl, PnlLeg } from './collector.ts';

/** Points kept for drawing the running total: enough for a smooth line, small enough to send often. */
const CURVE_POINTS = 240;

export type PnlOptions = {
  /** Round-trip cost charged to every trade, in basis points. */
  feeBps: number;
  /** Stake per trade, so the result can be shown in money as well as basis points. */
  notionalUsd: number;
};

/** Evenly spaced points, keeping the first and the last. */
function thin<T>(xs: T[], most: number): T[] {
  if (xs.length <= most) return xs;
  const step = (xs.length - 1) / (most - 1);
  return Array.from({ length: most }, (_, i) => xs[Math.round(i * step)]!);
}

function leg(recs: DecisionRecord[], horizonS: number, feeBps: number): PnlLeg {
  const curve: { t: number; cumBps: number }[] = [];
  let total = 0;
  let peak = 0;
  let drawdown = 0;
  let wins = 0;
  let losses = 0;
  let best: number | null = null;
  let worst: number | null = null;

  for (const rec of recs) {
    const signal = rec.signals[`jev_${horizonS}s`];
    const move = bps(rec.fwdResp[horizonS], rec.midResp);
    // No lean, or the price then is unknown: no trade. A move of exactly zero is a real trade
    // that simply made nothing, so it counts.
    if (typeof signal !== 'number' || !Number.isFinite(signal) || signal === 0 || !Number.isFinite(move)) continue;
    const got = Math.sign(signal) * move - feeBps;
    total += got;
    peak = Math.max(peak, total);
    drawdown = Math.max(drawdown, peak - total);
    if (got > 0) wins++;
    else if (got < 0) losses++;
    best = best === null ? got : Math.max(best, got);
    worst = worst === null ? got : Math.min(worst, got);
    curve.push({ t: rec.tResp, cumBps: total });
  }

  const trades = curve.length;
  return {
    horizonS,
    trades,
    wins,
    losses,
    totalBps: total,
    avgBps: trades > 0 ? total / trades : null,
    bestBps: best,
    worstBps: worst,
    maxDrawdownBps: drawdown,
    curve: thin(curve, CURVE_POINTS),
  };
}

/** Every finished decision in the window, turned into the trades it would have caused. */
export function pnlReport(recs: DecisionRecord[], { feeBps, notionalUsd }: PnlOptions): Pnl {
  return {
    n: recs.length,
    since: recs.length > 0 ? Math.min(...recs.map(r => r.tState)) : null,
    feeBps,
    notionalUsd,
    legs: Object.values(DIRECTIONS).map(d => leg(recs, d.seconds, feeBps)),
  };
}
