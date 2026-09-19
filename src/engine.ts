// Live decision loop: market events -> state -> Jev -> decision record.
// Every stage is timestamped so the analyzer can attribute latency, and each record
// waits for its forward mids before being written.

import type { Experimental_EvaluationModel as EvaluationModel } from 'ai';
import { config } from './config.ts';
import { nowMs, type MarketEvent } from './feed/types.ts';
import { encode } from './market/encode.ts';
import { MarketState, type Features } from './market/state.ts';
import { decide, directionSignal, RateLimitedError, type ModelResult } from './model/jev.ts';

export type DecisionRecord = {
  mode: 'live' | 'backtest';
  provider: string;
  tState: number; // state snapshot (local clock, epoch ms)
  exchLagMs: number; // tState minus exchange time of the newest event in the state
  buildMs: number; // features + encoding
  modelMs: number; // model round trip (backtest: simulated)
  tResp: number; // decision available to act on
  inputTokens?: number;
  state: string;
  probabilities: ModelResult['probabilities'];
  /** Directional signals: Jev per horizon plus zero-latency baselines. */
  signals: Record<string, number>;
  midState: number;
  midResp: number;
  /** Horizon seconds -> mid at tState + H and at tResp + H. */
  fwdState: Record<number, number>;
  fwdResp: Record<number, number>;
};

export function baselineSignals(f: Features) {
  return { obi1: f.imb1, obi5: f.imb5, flow5: f.flow5, mom5: f.ret5 };
}

export function jevSignals(p: ModelResult['probabilities']) {
  return { jev_2s: directionSignal(p.dir_2s), jev_10s: directionSignal(p.dir_10s), jev_60s: directionSignal(p.dir_60s) };
}

export function fillForward(rec: DecisionRecord, state: MarketState) {
  // A horizon that has not elapsed yet (run stopped early) is unknown, not "unchanged".
  const at = (t: number) => (t <= state.lastRecvTs ? state.midAt(t) : NaN);
  for (const h of config.horizons) {
    rec.fwdState[h] = at(rec.tState + h * 1000);
    rec.fwdResp[h] = at(rec.tResp + h * 1000);
  }
}

export class LiveEngine {
  readonly state = new MarketState();
  readonly stats = { decisions: 0, written: 0, rateLimited: 0, timeouts: 0, errors: 0, lastModelMs: NaN };
  private inFlight = 0;
  private lastDecision = -Infinity;
  private backoffUntil = 0;
  private backoffMs = 5000;
  private readyAt = NaN;
  private pending: DecisionRecord[] = [];
  private readonly maxHorizonMs = Math.max(...config.horizons) * 1000;

  private readonly model: EvaluationModel;
  private readonly write: (r: DecisionRecord) => void;
  private readonly log: (s: string) => void;

  constructor(model: EvaluationModel, write: (r: DecisionRecord) => void, log: (s: string) => void) {
    this.model = model;
    this.write = write;
    this.log = log;
  }

  onEvent(e: MarketEvent) {
    this.state.apply(e);
    if (!this.state.ready) {
      this.readyAt = NaN;
      return;
    }
    if (Number.isNaN(this.readyAt)) this.readyAt = e.recvTs;
    this.flush(e.recvTs);
    this.maybeDecide(e.recvTs);
  }

  /** Write every pending record whose forward horizons have all elapsed. */
  flush(now: number, force = false) {
    if (this.pending.length === 0) return;
    const keep: DecisionRecord[] = [];
    for (const rec of this.pending) {
      if (force || now >= rec.tResp + this.maxHorizonMs) {
        fillForward(rec, this.state);
        this.write(rec);
        this.stats.written++;
      } else keep.push(rec);
    }
    this.pending = keep;
  }

  private maybeDecide(now: number) {
    if (
      !this.state.ready ||
      now - this.readyAt < config.warmupMs ||
      this.inFlight >= config.maxInFlight ||
      now - this.lastDecision < config.minIntervalMs ||
      now < this.backoffUntil
    )
      return;
    this.lastDecision = now;
    void this.decideNow();
  }

  private async decideNow() {
    const tState = nowMs();
    const f = this.state.features(tState);
    const text = encode(f, this.state, config.product, config.encoding);
    const tBuilt = nowMs();
    this.inFlight++;
    try {
      const res = await decide(this.model, text, AbortSignal.timeout(config.timeoutMs));
      const tResp = nowMs();
      this.backoffMs = 5000;
      this.stats.decisions++;
      this.stats.lastModelMs = tResp - tBuilt;
      this.pending.push({
        mode: 'live',
        provider: config.provider,
        tState,
        exchLagMs: tState - f.exchTs,
        buildMs: tBuilt - tState,
        modelMs: tResp - tBuilt,
        tResp,
        inputTokens: res.inputTokens,
        state: text,
        probabilities: res.probabilities,
        signals: { ...jevSignals(res.probabilities), ...baselineSignals(f) },
        midState: f.mid,
        midResp: this.state.book.mid,
        fwdState: {},
        fwdResp: {},
      });
    } catch (error) {
      if (error instanceof RateLimitedError) {
        this.stats.rateLimited++;
        this.backoffUntil = nowMs() + this.backoffMs;
        this.log(`rate limited; pausing decisions ${(this.backoffMs / 1000).toFixed(0)}s`);
        this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
      } else if ((error as Error).name === 'TimeoutError' || (error as Error).name === 'AbortError') {
        this.stats.timeouts++;
      } else {
        this.stats.errors++;
        this.log(`model error: ${(error as Error).message}`);
      }
    } finally {
      this.inFlight--;
      this.maybeDecide(nowMs()); // refill the slot immediately rather than waiting for the next event
    }
  }
}
