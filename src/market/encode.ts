// State -> text for Jev. Two encodings so their token cost and signal quality can
// be compared: `compact` (labeled prose-ish lines, z-scores for context) and `json`.
// Pre-computed features carry far more information per token than raw book levels.

import type { Features, MarketState } from './state.ts';

export type Encoding = 'compact' | 'json';

const sgn = (x: number, d = 1, unit = '') => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(d)}${unit}` : 'n/a');
const zs = (z: number) => (Number.isFinite(z) ? ` (z ${sgn(z)})` : '');

export function encode(f: Features, state: MarketState, product: string, encoding: Encoding): string {
  if (encoding === 'json') return JSON.stringify(round(f));
  // Minute precision: time of day is context, milliseconds are noise that Jev reacts to.
  const time = new Date(f.t).toISOString().slice(11, 16);
  return [
    `${product} ${time} UTC mid ${f.mid.toFixed(2)} (bid ${f.bid.toFixed(2)} / ask ${f.ask.toFixed(2)}, spread ${f.spreadBps.toFixed(3)}bp)`,
    `mid returns: 1s ${sgn(f.ret1, 2, 'bp')}, 5s ${sgn(f.ret5, 2, 'bp')}${zs(state.z('ret5', f.ret5))}, 30s ${sgn(f.ret30, 2, 'bp')}, 60s ${sgn(f.ret60, 2, 'bp')}; 1s volatility ${Number.isFinite(f.vol60) ? f.vol60.toFixed(2) + 'bp' : 'n/a'}${zs(state.z('vol60', f.vol60))}`,
    `taker flow, buy minus sell (${product.split('-')[0]}): 1s ${sgn(f.flow1, 3)}, 5s ${sgn(f.flow5, 3)}${zs(state.z('flow5', f.flow5))}, 30s ${sgn(f.flow30, 3)}`,
    `last 5s: ${f.trades5} trades${zs(state.z('trades5', f.trades5))} (${f.buys5} buy / ${f.sells5} sell), largest ${f.maxTrade5.toFixed(4)} ${f.maxTradeSide5 ?? '-'}`,
    `book imbalance (bid-ask)/(bid+ask): L1 ${sgn(f.imb1, 2)}${zs(state.z('imb1', f.imb1))}, L5 ${sgn(f.imb5, 2)}${zs(state.z('imb5', f.imb5))}, L20 ${sgn(f.imb20, 2)}`,
    `depth within 10bp: bid ${f.depthBid10.toFixed(2)}, ask ${f.depthAsk10.toFixed(2)}`,
  ].join('\n');
}

function round(f: Features) {
  return Object.fromEntries(
    Object.entries(f).map(([k, v]) => [k, typeof v === 'number' && !['t', 'exchTs', 'bid', 'ask', 'mid'].includes(k) ? Number(v.toFixed(3)) : v]),
  );
}
