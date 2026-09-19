// News decision loop: item -> instruments -> state -> one Jev call -> one record per instrument,
// each completed with forward prices.
//
// A model call is only worth making when its outcome can be measured. So before asking, the
// engine drops near-identical repeats of a story it has already handled, instruments whose
// market is closed, and instruments without a usable price right now. What is left is asked
// about in one call.
//
// Unlike the market-data loop, news is sparse and each item matters, so an item that hits the
// rate limit or a passing failure waits in a queue and is tried again, up to NEWS_MAX_AGE_S.
// Queue time is recorded so the analyzer can see what the wait cost.

import type { Experimental_EvaluationAnswer, Experimental_EvaluationModel as EvaluationModel, Experimental_EvaluationQuestion } from 'ai';
import { nowMs } from '../feed/types.ts';
import { Backoff } from '../lib/backoff.ts';
import type { Prices } from '../market/prices.ts';
import { ask, isTransient, RateLimitedError } from '../model/jev.ts';
import { instrument, route, sessionOf, type AssetClass, type Instrument, type Session } from './instruments.ts';
import { RecentNews } from './memory.ts';
import { newsQuestions, newsSignal, newsState } from './questions.ts';
import type { NewsItem } from './types.ts';

export type NewsRecord = {
  /** Record format version. Files written before versions existed have none. */
  v?: 2;
  kind: 'news';
  provider: string;
  item: NewsItem;
  symbol: string;
  assetClass: AssetClass;
  session: Session; // at receipt
  /** Whether this instrument's price kept updating after the decision (false: over the data plan's symbol limit). */
  tracked: boolean;
  spreadBps: number; // at the answer
  queueMs: number; // received -> evaluation started (rate-limit waits, retries)
  prepareMs: number; // subscribing / snapshotting prices
  attempts?: number; // model calls made for this item (1 unless something failed first)
  tState: number;
  buildMs: number;
  modelMs: number;
  providerMs?: number; // the part of modelMs the gateway spent waiting for TypeSafe
  tResp: number;
  inputTokens?: number; // for the whole call, shared by the item's instruments
  costUsd?: number; // list price of the whole call, shared by the item's instruments
  instruments: number; // how many instruments shared the call
  state: ReturnType<typeof newsState>;
  relevant: number; // P(yes)
  direction: Record<string, number>;
  magnitude: number; // 0..3 on the asset class's magnitude rubric
  magnitudeProbs: Record<string, number>;
  novel: number; // P(yes), shared by the item's instruments
  /** TypeSafe's confidence in the direction and magnitude answers. */
  confidence?: { direction?: number; magnitude?: number };
  signal: number;
  midPublished: number; // NaN when publication predates our price history
  midRecv: number;
  midResp: number;
  /** Horizon seconds -> mid at recvTs + H and at tResp + H. */
  fwdRecv: Record<number, number>;
  fwdResp: Record<number, number>;
  /** Stocks only: the quote's spread at tResp + H, to tell a real exit price from a gap between far-apart quotes. */
  fwdSpreadBps?: Record<number, number>;
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
  /** Ask only about instruments whose outcome can be measured (market open, usable quote, live prices). */
  onlyTradable: boolean;
  /** A stock quote wider than this is not a usable price. */
  maxSpreadBps: number;
  /** Full company name for a ticker, when known. */
  companyName?: (ticker: string) => string | undefined;
  /** The clock (tests replace it). */
  now?: () => number;
  write: (r: NewsRecord) => void;
  log: (s: string) => void;
};

/** Model calls per item before giving up on a failure that is not a rate limit. */
const MAX_ATTEMPTS = 3;

type Queued = { item: NewsItem; symbols: string[]; attempts: number; notBefore: number };
type Answer = Experimental_EvaluationAnswer<Experimental_EvaluationQuestion> | undefined;
const probability = (a: Answer) => (a?.type === 'boolean' ? a.probability : NaN);
const distribution = (a: Answer) => (a?.type === 'choice' ? (a.probabilities ?? { [a.choice]: 1 }) : {});

export class NewsEngine {
  readonly stats = {
    received: 0,
    decisions: 0,
    written: 0,
    /** Left out before any model call, by reason. */
    unpriceable: 0, // tagged only with instruments we have no prices for
    duplicates: 0, // a repeat of a recent headline
    closed: 0, // every instrument's market was closed
    unpriced: 0, // no usable quote right now
    dropped: 0, // waited too long for the model
    rateLimited: 0,
    retries: 0,
    errors: 0,
    costUsd: 0,
  };
  private readonly prices: Prices;
  private readonly opts: NewsEngineOptions;
  private readonly maxHorizonMs: number;
  private readonly memory = new RecentNews();
  private readonly backoff = new Backoff();
  /** Items waiting for a model call, oldest first. */
  private queue: Queued[] = [];
  /** Answered items waiting for their forward prices, oldest first. */
  private pending: NewsRecord[] = [];
  private inFlight = 0;
  private readonly now: () => number;

  constructor(prices: Prices, opts: NewsEngineOptions) {
    this.prices = prices;
    this.opts = opts;
    this.now = opts.now ?? nowMs;
    this.maxHorizonMs = Math.max(...opts.horizonsS) * 1000;
  }

  get queued() {
    return this.queue.length;
  }

  onItem(item: NewsItem) {
    this.stats.received++;
    const symbols = route(item, this.opts.maxSymbolsPerItem, this.opts.untagged);
    if (symbols.length === 0) {
      this.stats.unpriceable++;
      return;
    }
    const earlier = this.memory.duplicateOf(item, symbols);
    if (earlier) {
      this.stats.duplicates++;
      this.opts.log(`skip (repeat of "${earlier.headline.slice(0, 50)}"): ${item.headline.slice(0, 80)}`);
      return;
    }
    this.memory.add(item, symbols);
    this.queue.push({ item, symbols, attempts: 0, notBefore: 0 });
    this.pump();
  }

  /** Call regularly (once a second is plenty): writes finished records, retries the queue, releases prices. */
  tick(now: number) {
    this.flush(now);
    this.pump();
    this.prices.tick(now);
  }

  /** Write every pending record whose forward horizons have all elapsed (all of them if `force`). */
  flush(now: number, force = false) {
    while (this.pending.length > 0 && (force || now >= this.pending[0]!.tResp + this.maxHorizonMs)) {
      const rec = this.pending.shift()!;
      this.fillForward(rec, now);
      this.opts.write(rec);
      this.stats.written++;
    }
  }

  private pump() {
    const now = this.now();
    if (this.backoff.waiting(now)) return;
    for (let i = 0; i < this.queue.length && this.inFlight < this.opts.maxInFlight; ) {
      const q = this.queue[i]!;
      if (now - q.item.recvTs > this.opts.maxAgeMs) {
        this.queue.splice(i, 1);
        this.stats.dropped++;
        this.memory.unanswered(q.item.id);
        this.opts.log(`dropped (waited ${((now - q.item.recvTs) / 1000).toFixed(0)}s): ${q.item.headline.slice(0, 80)}`);
      } else if (q.notBefore > now) i++;
      else {
        this.queue.splice(i, 1);
        void this.evaluate(q);
      }
    }
  }

  /** Put an item back in line, keeping the queue in order of arrival. */
  private requeue(q: Queued) {
    const at = this.queue.findIndex(x => x.item.recvTs > q.item.recvTs);
    this.queue.splice(at < 0 ? this.queue.length : at, 0, q);
  }

  /** Can this instrument's outcome be measured? Returns the reason if not. */
  private untradable(ins: Instrument, tracked: Set<string>): string | undefined {
    if (!Number.isFinite(this.prices.mid(ins.symbol))) return `${ins.symbol} has no price`;
    if (!tracked.has(ins.symbol)) return `${ins.symbol} is over the live-quote limit`;
    const spread = this.prices.spreadBps(ins.symbol);
    if (ins.assetClass === 'equity' && !(spread <= this.opts.maxSpreadBps)) return `${ins.symbol} quote is ${Number.isFinite(spread) ? spread.toFixed(0) + 'bp' : 'unknown'} wide`;
    return undefined;
  }

  private async evaluate(q: Queued) {
    const { item } = q;
    this.inFlight++;
    q.attempts++; // counted up front, so a failure at any step below cannot retry forever
    const tPrepare = this.now();
    try {
      let instruments = q.symbols.map(s => instrument(s, this.opts.companyName));
      if (this.opts.onlyTradable) {
        instruments = instruments.filter(ins => sessionOf(ins, tPrepare) !== 'closed');
        if (instruments.length === 0) {
          this.stats.closed++;
          this.memory.unanswered(item.id);
          return;
        }
      }
      // Keep prices live until the longest horizon, with margin for model time.
      const tracked = await this.prices.prepare(instruments.map(i => i.symbol), tPrepare + this.maxHorizonMs + 60_000, item.recvTs);
      if (this.opts.onlyTradable) {
        const reasons = instruments.map(ins => this.untradable(ins, tracked));
        instruments = instruments.filter((_, i) => reasons[i] === undefined);
        if (instruments.length === 0) {
          this.stats.unpriced++;
          this.memory.unanswered(item.id);
          this.opts.log(`skip (${reasons.join('; ')}): ${item.headline.slice(0, 80)}`);
          return;
        }
      }

      const tState = this.now();
      const earlier = this.memory.related(item, instruments.map(i => i.symbol), tState);
      const state = newsState(item, instruments, this.prices, earlier, tState);
      const questions = newsQuestions(instruments, this.maxHorizonMs / 1000, earlier.length > 0);
      const tBuilt = this.now();
      const res = await ask(this.opts.model, state, questions, AbortSignal.timeout(this.opts.timeoutMs));
      const tResp = this.now();
      this.backoff.succeed();
      this.stats.costUsd += res.meta.costUsd ?? 0;
      const answers = res.answers as Record<string, Answer>;
      const novel = probability(answers.novel);
      const summary: string[] = [];
      instruments.forEach((ins, i) => {
        const relevant = probability(answers[`relevant_${i}`]);
        const direction = distribution(answers[`direction_${i}`]);
        const magnitude = answers[`magnitude_${i}`];
        const score = magnitude?.type === 'score' ? magnitude.score : NaN;
        const confidence = { direction: res.meta.confidence?.[`direction_${i}`], magnitude: res.meta.confidence?.[`magnitude_${i}`] };
        this.pending.push({
          v: 2,
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
          attempts: q.attempts,
          tState,
          buildMs: tBuilt - tState,
          modelMs: tResp - tBuilt,
          ...(res.meta.providerMs !== undefined ? { providerMs: res.meta.providerMs } : {}),
          tResp,
          ...(res.meta.inputTokens !== undefined ? { inputTokens: res.meta.inputTokens } : {}),
          ...(res.meta.costUsd !== undefined ? { costUsd: res.meta.costUsd } : {}),
          instruments: instruments.length,
          state,
          relevant,
          direction,
          magnitude: score,
          magnitudeProbs: magnitude?.type === 'score' ? (magnitude.probabilities ?? {}) : {},
          novel,
          ...(confidence.direction !== undefined || confidence.magnitude !== undefined ? { confidence } : {}),
          signal: newsSignal(relevant, direction),
          midPublished: item.publishedTs ? this.prices.midAt(ins.symbol, item.publishedTs) : NaN,
          midRecv: this.prices.midAt(ins.symbol, item.recvTs),
          midResp: this.prices.mid(ins.symbol),
          fwdRecv: {},
          fwdResp: {},
        });
        summary.push(`${ins.symbol} rel ${relevant.toFixed(2)} bull ${(direction.bullish ?? 0).toFixed(2)} bear ${(direction.bearish ?? 0).toFixed(2)} mag ${score.toFixed(2)}`);
      });
      this.stats.decisions++;
      this.opts.log(`jev ${(tResp - tBuilt).toFixed(0)}ms novel ${novel.toFixed(2)} | ${summary.join(' | ')} | ${item.source}: ${item.headline.slice(0, 80)}`);
    } catch (error) {
      const now = this.now();
      if (error instanceof RateLimitedError) {
        this.stats.rateLimited++;
        q.attempts--; // a refusal is not an attempt: the model never saw it
        this.requeue(q); // news is sparse: wait for capacity rather than lose the item
        this.opts.log(`rate limited; retrying queued news in ${(this.backoff.fail(now) / 1000).toFixed(0)}s`);
      } else if (isTransient(error) && q.attempts < MAX_ATTEMPTS) {
        this.stats.retries++;
        q.notBefore = now + 2000 * q.attempts;
        this.requeue(q);
        this.opts.log(`model call failed (${(error as Error).message}); trying again in ${2 * q.attempts}s`);
      } else {
        this.stats.errors++;
        this.memory.unanswered(item.id);
        this.opts.log(`model error, item lost: ${(error as Error).message} | ${item.headline.slice(0, 80)}`);
      }
    } finally {
      this.inFlight--;
      queueMicrotask(() => this.pump()); // not inline: this may be running inside pump's own loop
    }
  }

  private fillForward(rec: NewsRecord, now: number) {
    // Unknown, not "unchanged": horizons that have not elapsed (run stopped early), and any
    // instrument whose price stopped updating (not tracked).
    const known = (t: number) => rec.tracked && t <= now;
    if (rec.assetClass === 'equity') rec.fwdSpreadBps = {};
    for (const h of this.opts.horizonsS) {
      const tRecv = rec.item.recvTs + h * 1000;
      const tResp = rec.tResp + h * 1000;
      rec.fwdRecv[h] = known(tRecv) ? this.prices.midAt(rec.symbol, tRecv) : NaN;
      rec.fwdResp[h] = known(tResp) ? this.prices.midAt(rec.symbol, tResp) : NaN;
      if (rec.fwdSpreadBps) rec.fwdSpreadBps[h] = known(tResp) ? this.prices.spreadAt(rec.symbol, tResp) : NaN;
    }
  }
}
