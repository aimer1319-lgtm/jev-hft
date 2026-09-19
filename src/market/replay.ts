// Replaying recorded events for a backtest: take a snapshot of the market every `stepMs`.

import type { MarketEvent } from '../feed/types.ts';
import type { MarketState } from './state.ts';

/**
 * Returns a function to feed recorded events to, in order. It calls `take(t)` for every
 * snapshot time `t` once the book has had `warmupMs` to fill its history.
 *
 * The order of the two steps is what keeps a backtest honest: `take(t)` runs BEFORE the first
 * event received at or after `t` is applied, so a snapshot only ever knows what was known at
 * its own moment. Swapping them would let every snapshot peek a few milliseconds into its future.
 */
export function replayer(state: MarketState, stepMs: number, warmupMs: number, take: (t: number) => void) {
  let next = NaN;
  return (e: MarketEvent) => {
    while (state.ready && e.recvTs >= next) {
      take(next);
      next += stepMs;
    }
    state.apply(e);
    if (!state.ready) next = NaN; // the feed broke: warm up again after the next snapshot
    else if (Number.isNaN(next)) next = e.recvTs + warmupMs;
  };
}
