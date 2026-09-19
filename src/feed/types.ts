// Normalized market events. All timestamps are epoch milliseconds (fractional).
// `recvTs` is the local receive time and is the clock the whole pipeline runs on,
// so live runs and replays of recorded data behave identically.

export type Aggressor = 'buy' | 'sell';

export type LevelUpdate = { side: 'bid' | 'ask'; price: number; size: number };

export type MarketEvent =
  | { type: 'book'; snapshot: boolean; updates: LevelUpdate[]; exchTs: number; recvTs: number }
  | { type: 'trade'; price: number; size: number; aggressor: Aggressor; exchTs: number; recvTs: number }
  // Feed discontinuity (reconnect or sequence gap): state must be rebuilt from the next snapshot.
  | { type: 'reset'; recvTs: number };

export type Feed = { close(): void };

/** Epoch ms with sub-millisecond resolution, monotonic within a process. */
export const nowMs = () => performance.timeOrigin + performance.now();
