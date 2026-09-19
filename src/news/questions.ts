// What Jev is asked about each news item, and the state it sees.
//
// One call per item. For each instrument the item is routed to, three questions: relevance
// and magnitude are "will this matter" (volatility), direction is "which way". Novelty is about
// the item itself, so it is asked once; it filters recaps and price reports that describe moves
// that already happened. TypeSafe evaluates all questions in parallel, so extra instruments cost
// tokens, not latency.

import type { Experimental_EvaluationQuestion as Question } from 'ai';
import { bps } from '../lib/stats.ts';
import type { Prices } from '../market/prices.ts';
import { usSession, type AssetClass, type Instrument } from './instruments.ts';
import type { NewsItem } from './types.ts';

/** Magnitude rubric per asset class: stocks routinely move more on their own news than Bitcoin. */
const MAGNITUDE: Record<AssetClass, string[]> = {
  crypto: ['Negligible', 'Small: under 0.2%', 'Moderate: 0.2% to 1%', 'Large: over 1%'],
  equity: ['Negligible', 'Small: under 0.5%', 'Moderate: 0.5% to 2%', 'Large: over 2%'],
};

/** Question ids: `novel`, then `relevant_<i>`, `direction_<i>`, `magnitude_<i>` per instrument index. */
export function newsQuestions(instruments: Instrument[]): Record<string, Question> {
  const questions: Record<string, Question> = {
    novel: {
      type: 'boolean',
      instructions: 'Is this new information, rather than a recap, opinion, price report, or follow-up on already known news?',
    },
  };
  instruments.forEach((ins, i) => {
    questions[`relevant_${i}`] = {
      type: 'boolean',
      instructions: `Could this news plausibly move the price of ${ins.name} within the next hour?`,
    };
    questions[`direction_${i}`] = {
      type: 'choice',
      instructions: `If this news moves ${ins.name}, which way would it push the price?`,
      criteria: { bullish: 'Price rises', bearish: 'Price falls', neutral: 'No clear direction' },
    };
    questions[`magnitude_${i}`] = {
      type: 'score',
      instructions: `How large a ${ins.name} price reaction could this news cause within an hour?`,
      criteria: MAGNITUDE[ins.assetClass],
    };
  });
  return questions;
}

/** Directional signal: relevance-weighted P(bullish) - P(bearish). */
export const newsSignal = (relevant: number, direction: Record<string, number>) =>
  relevant * ((direction.bullish ?? 0) - (direction.bearish ?? 0));

const fmt = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(1)}bp` : 'n/a');

/** The state for one item: the text, how stale it is, and what each instrument has been doing. */
export function newsState(item: NewsItem, instruments: Instrument[], prices: Prices, now: number) {
  return {
    headline: item.headline,
    ...(item.summary ? { summary: item.summary } : {}),
    source: item.source,
    published: item.publishedTs ? `${new Date(item.publishedTs).toISOString().slice(0, 16)}Z` : 'unknown',
    minutes_since_published: item.publishedTs ? Math.max(0, Math.round((now - item.publishedTs) / 60_000)) : 'unknown',
    markets: Object.fromEntries(instruments.map(ins => [ins.symbol, marketLine(ins, prices, now)])),
  };
}

function marketLine(ins: Instrument, prices: Prices, now: number): string {
  const mid = prices.mid(ins.symbol);
  if (!Number.isFinite(mid)) return `${ins.name}: no recent price`;
  const change = (seconds: number) => fmt(bps(mid, prices.midAt(ins.symbol, now - seconds * 1000)));
  // Stock quotes can be very wide outside regular hours (IEX-only data especially); the spread
  // tells the model how much to trust the price.
  const quality = ins.assetClass === 'equity' ? ` (quote spread ${prices.spreadBps(ins.symbol).toFixed(0)}bp), US session ${usSession(now)}` : '';
  return `${ins.name} ${mid.toFixed(2)}${quality}; change over last 1m ${change(60)}, 5m ${change(300)}, 30m ${change(1800)}`;
}
