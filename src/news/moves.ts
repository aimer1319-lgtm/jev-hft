// When does a price move after a news decision count? One rule, used by the news report and by
// the dashboard, so the two can never disagree.

import { bps, num } from '../lib/stats.ts';
import type { NewsRecord } from './engine.ts';

const usable = (spreadBps: unknown, maxSpreadBps: number) => num(spreadBps) <= maxSpreadBps;

/** Was there a real price to start from? Bitcoin: always. A stock: market not closed, and bid and ask close together. */
export const entryOk = (r: NewsRecord, maxSpreadBps: number) =>
  r.assetClass === 'crypto' || (r.session !== 'closed' && usable(r.spreadBps, maxSpreadBps));

/** Was there a real price at the later check? Records from before later spreads were stored are checked at the start only. */
export const exitOk = (r: NewsRecord, horizonS: number, maxSpreadBps: number) =>
  r.assetClass === 'crypto' || r.fwdSpreadBps === undefined || usable(r.fwdSpreadBps[horizonS], maxSpreadBps);

/**
 * The move someone could have traded: from when the answer arrived to `horizonS` later, in basis
 * points. NaN (unknown) unless there was a usable price at both ends. A story at 3:50 pm has its
 * 30-minute check after the close, when the midpoint of a thin quote can sit far from the last
 * real price and look like a move that never happened.
 */
export const tradableMove = (r: NewsRecord, horizonS: number, maxSpreadBps: number) =>
  entryOk(r, maxSpreadBps) && exitOk(r, horizonS, maxSpreadBps) ? bps(r.fwdResp[horizonS], r.midResp) : NaN;
