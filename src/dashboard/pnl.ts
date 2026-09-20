// What trading on Jev's answers would have made, under two rules.
//
// "baseline" is the simplest rule that could actually have been followed: when Jev leans a way,
// take that side at the price its answer arrived at, hold for the horizon, close at the mid.
// Every lean is traded, all the same size.
//
// "filtered" is the same rule, refined: it sits out a call unless a simple, zero-latency rule
// (order-book imbalance, trade flow, momentum) points the same way, sits out if a headline from
// the last few minutes leans the other way, and sizes each trade by how strong Jev's lean was and
// how sure TypeSafe reported being, instead of betting the same amount on every call.
//
// Neither rule looks at how the run turned out before deciding what to trade, which is the
// difference between this and the "net edge" in the report (src/analyze.ts): that one sorts the
// whole run into quintiles to find its strongest signals, and you could only do that afterwards.

import type { DecisionRecord } from '../engine.ts';
import { bps, num } from '../lib/stats.ts';
import { DIRECTIONS } from '../model/jev.ts';
import type { NewsRecord } from '../news/engine.ts';
import type { Pnl, PnlLeg, PnlSet } from './collector.ts';

/** Points kept for drawing the running total: enough for a smooth line, small enough to send often. */
const CURVE_POINTS = 240;
const RULES = ['obi1', 'obi5', 'flow5', 'mom5'] as const;
/** How long a headline's lean still counts as "recent" when deciding whether to trade. */
const NEWS_LOOKBACK_MS = 15 * 60_000;
/** Extra size when a recent, relevant headline leans the same way Jev does. */
const NEWS_AGREEMENT_BOOST = 0.25;

export type PnlOptions = {
  /** Round-trip cost charged to every trade, in basis points. */
  feeBps: number;
  /** Stake per trade at full size, so the result can be shown in money as well as basis points. */
  notionalUsd: number;
  /** The instrument being traded, so a headline about something else is never mistaken for a fundamental opinion. */
  product: string;
};

/** A trade to take, and how much of a full-size stake to put on it; null means sit this one out. */
type Decision = { dir: 1 | -1; sizeFraction: number } | null;

function baselineDecision(rec: DecisionRecord, horizonS: number): Decision {
  const signal = rec.signals[`jev_${horizonS}s`];
  if (typeof signal !== 'number' || !Number.isFinite(signal) || signal === 0) return null;
  return { dir: Math.sign(signal) as 1 | -1, sizeFraction: 1 };
}

/**
 * `news` must already be about the traded instrument and sorted ascending by `tResp`. Only records
 * with `tResp <= rec.tState` are ever looked at, so a headline is never used before its answer
 * actually existed.
 */
function filteredDecision(rec: DecisionRecord, horizonS: number, news: readonly NewsRecord[]): Decision {
  const signal = rec.signals[`jev_${horizonS}s`];
  if (typeof signal !== 'number' || !Number.isFinite(signal) || signal === 0) return null;
  const dir = Math.sign(signal) as 1 | -1;

  const agrees = RULES.some(key => Math.sign(num(rec.signals[key])) === dir);
  if (!agrees) return null; // nothing zero-latency backs this call up

  const recent = news.findLast(n => n.tResp <= rec.tState && rec.tState - n.tResp <= NEWS_LOOKBACK_MS);
  const newsDir = recent ? Math.sign(recent.signal) : 0;
  if (newsDir !== 0 && newsDir !== dir) return null; // a fresh headline says the other way

  const confidence = num(rec.confidence?.[`dir_${horizonS}s`]);
  const conviction = Math.abs(signal) * (Number.isFinite(confidence) ? confidence : 1);
  const sizeFraction = Math.min(1, conviction) * (newsDir === dir ? 1 + NEWS_AGREEMENT_BOOST : 1);
  return { dir, sizeFraction };
}

/** Evenly spaced points, keeping the first and the last. */
function thin<T>(xs: T[], most: number): T[] {
  if (xs.length <= most) return xs;
  const step = (xs.length - 1) / (most - 1);
  return Array.from({ length: most }, (_, i) => xs[Math.round(i * step)]!);
}

function leg(recs: DecisionRecord[], horizonS: number, feeBps: number, decide: (rec: DecisionRecord, horizonS: number) => Decision): PnlLeg {
  const curve: { t: number; cumBps: number }[] = [];
  let total = 0;
  let peak = 0;
  let drawdown = 0;
  let wins = 0;
  let losses = 0;
  let best: number | null = null;
  let worst: number | null = null;

  for (const rec of recs) {
    const decision = decide(rec, horizonS);
    if (!decision) continue;
    const move = bps(rec.fwdResp[horizonS], rec.midResp);
    if (!Number.isFinite(move)) continue; // the horizon hasn't finished yet
    // Unweighted: what the call itself was worth, so "best"/"worst" describe the call, not the stake.
    const gotBps = decision.dir * move - feeBps;
    if (gotBps > 0) wins++;
    else if (gotBps < 0) losses++;
    best = best === null ? gotBps : Math.max(best, gotBps);
    worst = worst === null ? gotBps : Math.min(worst, gotBps);
    total += gotBps * decision.sizeFraction;
    peak = Math.max(peak, total);
    drawdown = Math.max(drawdown, peak - total);
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

function report(recs: DecisionRecord[], { feeBps, notionalUsd }: PnlOptions, decide: (rec: DecisionRecord, horizonS: number) => Decision): Pnl {
  return {
    n: recs.length,
    since: recs.length > 0 ? Math.min(...recs.map(r => r.tState)) : null,
    feeBps,
    notionalUsd,
    legs: Object.values(DIRECTIONS).map(d => leg(recs, d.seconds, feeBps, decide)),
  };
}

/**
 * Both strategies over the same finished decisions. `news` can be every finished news record the
 * dashboard has kept, about any instrument; only ones matching `opts.product` are ever looked at.
 * It can be empty (most sources publish only a few times an hour, so long quiet stretches are
 * normal) and the filtered strategy simply never gets a fundamental opinion during them.
 */
export function pnlReport(recs: DecisionRecord[], opts: PnlOptions, news: readonly NewsRecord[] = []): PnlSet {
  const relevant = news.filter(n => n.symbol === opts.product);
  return {
    baseline: report(recs, opts, baselineDecision),
    filtered: report(recs, opts, (rec, h) => filteredDecision(rec, h, relevant)),
  };
}
