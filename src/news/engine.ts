// News decision loop: item -> instruments -> state -> one Jev call -> one record per instrument,
// each completed with forward prices.
//
// Unlike the microstructure loop, news is sparse and each item matters, so a rate-limited
// item waits in a queue instead of being dropped, up to NEWS_MAX_AGE_S. Queue time is
// recorded so the analyzer can see what the wait cost.

import type { Experimental_EvaluationAnswer, Experimental_EvaluationModel as EvaluationModel, Experimental_EvaluationQuestion } from 'ai';
import { nowMs } from '../feed/types.ts';
import type { Prices } from '../market/prices.ts';
import { ask, RateLimitedError } from '../model/jev.ts';
import { instrument, route, sessionOf, type AssetClass, type Session } from './instruments.ts';
import { newsQuestions, newsSignal, newsState } from './questions.ts';
import type { NewsItem } from './types.ts';

export type NewsRecord = {
  kind: 'news';
  provider: string;
  item: NewsItem;
  symbol: string;
  assetClass: AssetClass;
  session: Session; // at receipt
  /** Whether this instrument's price kept updating after the decision (false: over the data plan's symbol limit). */
  tracked: boolean;
  spreadBps: number; // at the answer
  queueMs: number; // received -> evaluation started (rate-limit waits)
  prepareMs: number; // subscribing / snapshotting prices
  tState: number;
  buildMs: number;
  modelMs: number;
  tResp: number;
  inputTokens?: number; // for the whole call, shared by the item's instruments
  instruments: number; // how many instruments shared the call
  state: ReturnType<typeof newsState>;
  relevant: number; // P(yes)
  direction: Record<string, number>;
  magnitude: number; // 0..3 on the asset class's magnitude rubric
  magnitudeProbs: Record<string, number>;
  novel: number; // P(yes), shared by the item's instruments
  signal: number;
  midPublished: number; // NaN when publication predates our price history
  midRecv: number;
  midResp: number;
  /** Horizon seconds -> mid at recvTs + H and at tResp + H. */
  fwdRecv: Record<number, number>;
  fwdResp: Record<number, number>;
};

export type NewsEngineOptions = {
  model: EvaluationModel;
  provider: string;
  horizonsS: number[];
  maxAgeMs: number;
  maxInFlight: number;
  maxSymbolsPerItem: number;
  untagged: string[];
  timeoutMs: number;
  write: (r: NewsRecord) => void;
  log: (s: string) => void;
};

type Answer = Experimental_EvaluationAnswer<Experimental_EvaluationQuestion> | undefined;
const probability = (a: Answer) => (a?.type === 'boolean' ? a.probability : NaN);
const distribution = (a: Answer) => (a?.type === 'choice' ? (a.probabilities ?? { [a.choice]: 1 }) : {});

export class NewsEngine {
  readonly stats = { received: 0, decisions: 0, written: 0, skipped: 0, dropped: 0, rateLimited: 0, errors: 0 };
  private readonly prices: Prices;
  private readonly opts: NewsEngineOptions;
  private readonly maxHorizonMs: number;
  private queue: NewsItem[] = [];
  private pending: NewsRecord[] = [];
  private inFlight = 0;
  private backoffUntil = 0;
  private backoffMs = 5000;

  constructor(prices: Prices, opts: NewsEngineOptions) {
    this.prices = prices;
    this.opts = opts;
    this.maxHorizonMs = Math.max(...opts.horizonsS) * 1000;
  }

  get queued() {
    return this.queue.length;
  }

  onItem(item: NewsItem) {
    this.stats.received++;
    this.queue.push(item);
    this.pump();
  }

  /** Call on every market event: writes finished records, retries the queue, releases prices. */
  tick(now: number) {
    this.flush(now);
    this.pump();
    this.prices.tick(now);
  }

  flush(now: number, force = false) {
    if (this.pending.length === 0) return;
    const keep: NewsRecord[] = [];
    for (const rec of this.pending) {
      if (force || now >= rec.tResp + this.maxHorizonMs) {
        this.fillForward(rec, now);
        this.opts.write(rec);
        this.stats.written++;
      } else keep.push(rec);
    }
    this.pending = keep;
  }

  private pump() {
    const now = nowMs();
    if (now < this.backoffUntil) return;
    while (this.inFlight < this.opts.maxInFlight && this.queue.length > 0) {
      const item = this.queue.shift()!;
      if (now - item.recvTs > this.opts.maxAgeMs) {
        this.stats.dropped++;
        this.opts.log(`dropped (waited ${((now - item.recvTs) / 1000).toFixed(0)}s): ${item.headline.slice(0, 80)}`);
        continue;
      }
      void this.evaluate(item);
    }
  }

  private async evaluate(item: NewsItem) {
    const symbols = route(item, this.opts.maxSymbolsPerItem, this.opts.untagged);
    if (symbols.length === 0) {
      this.stats.skipped++; // tagged only with instruments we cannot price
      return;
    }
    this.inFlight++;
    const instruments = symbols.map(instrument);
    const tPrepare = nowMs();
    try {
      // Keep prices live until the longest horizon, with margin for model time.
      const tracked = await this.prices.prepare(symbols, tPrepare + this.maxHorizonMs + 60_000, item.recvTs);
      const tState = nowMs();
      const state = newsState(item, instruments, this.prices, tState);
      const tBuilt = nowMs();
      const res = await ask(this.opts.model, state, newsQuestions(instruments), AbortSignal.timeout(this.opts.timeoutMs));
      const tResp = nowMs();
      this.backoffMs = 5000;
      const answers = res.answers as Record<string, Answer>;
      const novel = probability(answers.novel);
      const summary: string[] = [];
      instruments.forEach((ins, i) => {
        const relevant = probability(answers[`relevant_${i}`]);
        const direction = distribution(answers[`direction_${i}`]);
        const magnitude = answers[`magnitude_${i}`];
        this.pending.push({
          kind: 'news',
          provider: this.opts.provider,
          item,
          symbol: ins.symbol,
          assetClass: ins.assetClass,
          session: sessionOf(ins, item.recvTs),
          tracked: tracked.has(ins.symbol),
          spreadBps: this.prices.spreadBps(ins.symbol),
          queueMs: tPrepare - item.recvTs,
          prepareMs: tState - tPrepare,
          tState,
          buildMs: tBuilt - tState,
          modelMs: tResp - tBuilt,
          tResp,
          inputTokens: res.usage.inputTokens,
          instruments: instruments.length,
          state,
          relevant,
          direction,
          magnitude: magnitude?.type === 'score' ? magnitude.score : NaN,
          magnitudeProbs: magnitude?.type === 'score' ? (magnitude.probabilities ?? {}) : {},
          novel,
          signal: newsSignal(relevant, direction),
          midPublished: item.publishedTs ? this.prices.midAt(ins.symbol, item.publishedTs) : NaN,
          midRecv: this.prices.midAt(ins.symbol, item.recvTs),
          midResp: this.prices.mid(ins.symbol),
          fwdRecv: {},
          fwdResp: {},
        });
        summary.push(`${ins.symbol} rel ${relevant.toFixed(2)} bull ${(direction.bullish ?? 0).toFixed(2)} bear ${(direction.bearish ?? 0).toFixed(2)} mag ${this.pending.at(-1)!.magnitude.toFixed(2)}`);
      });
      this.stats.decisions++;
      this.opts.log(`jev ${(tResp - tBuilt).toFixed(0)}ms novel ${novel.toFixed(2)} | ${summary.join(' | ')} | ${item.source}: ${item.headline.slice(0, 80)}`);
    } catch (error) {
      if (error instanceof RateLimitedError) {
        this.stats.rateLimited++;
        this.queue.unshift(item); // news is sparse: wait for capacity rather than lose the item
        this.backoffUntil = nowMs() + this.backoffMs;
        this.opts.log(`rate limited; retrying queued news in ${(this.backoffMs / 1000).toFixed(0)}s`);
        this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
      } else {
        this.stats.errors++;
        this.opts.log(`model error: ${(error as Error).message}`);
      }
    } finally {
      this.inFlight--;
    }
  }

  private fillForward(rec: NewsRecord, now: number) {
    // Unknown, not "unchanged": horizons that have not elapsed (run stopped early), and any
    // instrument whose price stopped updating (not tracked).
    const at = (t: number) => (rec.tracked && t <= now ? this.prices.midAt(rec.symbol, t) : NaN);
    for (const h of this.opts.horizonsS) {
      rec.fwdRecv[h] = at(rec.item.recvTs + h * 1000);
      rec.fwdResp[h] = at(rec.tResp + h * 1000);
    }
  }
}
