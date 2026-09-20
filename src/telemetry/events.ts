// The messages a running pipeline sends to the dashboard. Types only: this file is shared by
// the pipeline (which sends them), the dashboard server (which collects them), and the page in
// the browser (which draws them), and it must stay free of anything that runs.
//
// Every message is small, self-contained, and safe to lose. The pipeline never waits for one to
// be delivered, and nothing the pipeline records depends on them.

import type { FlatThresholds, Probabilities } from '../model/jev.ts';

export type Program = 'live' | 'news';

/** Added to every message by the sender. */
export type Envelope = {
  v: 1;
  /** When it was emitted (the pipeline's clock, epoch ms). */
  t: number;
  program: Program;
  /** When the sending process started: tells one run of a program from the next. */
  run: number;
};

// ---- both programs --------------------------------------------------------------------

export type SourceStatus = { name: string; polls: number; notModified: number; items: number; errors: number };

/** Once a second: "still here", the latest price, and the running counters. */
export type Pulse =
  | {
      type: 'pulse';
      program: 'live';
      meta: { provider: string; product: string; minIntervalMs: number; flatSigmas: number; warmupMs: number; recording: boolean };
      market: { ready: boolean; mid: number | null; bid: number | null; ask: number | null };
      stats: { decisions: number; written: number; rateLimited: number; timeouts: number; errors: number; costUsd: number };
      /** Measured over the last second. */
      feed: { eventsPerS: number; lagMs: number | null };
      /** Measured over the last status window (10 s): time to handle one market update, in microseconds. */
      eventCostUs: { p50: number; p99: number } | null;
    }
  | {
      type: 'pulse';
      program: 'news';
      meta: { provider: string; onlyTradable: boolean; maxSpreadBps: number; horizonsS: number[] };
      market: { ready: boolean; mid: number | null };
      stats: {
        received: number;
        decisions: number;
        written: number;
        unpriceable: number;
        duplicates: number;
        closed: number;
        unpriced: number;
        dropped: number;
        rateLimited: number;
        retries: number;
        errors: number;
        costUsd: number;
      };
      queued: number;
      stocks: { watching: number; max: number; rejected: number; reconnects: number } | null;
      sources: SourceStatus[];
    };

// ---- market-data path -------------------------------------------------------------------

/** A question has just been sent to Jev. */
export type Ask = {
  type: 'ask';
  program: 'live';
  /** Counts up from 1 within a run; `answer` and `fail` refer to it. */
  id: number;
  tState: number;
  /** Exactly the text Jev was sent. */
  state: string;
  flatBps: FlatThresholds;
  features: {
    mid: number;
    spreadBps: number;
    imb1: number;
    imb5: number;
    imb20: number;
    ret5: number | null;
    ret60: number | null;
    vol60: number | null;
    flow5: number;
    trades5: number;
  };
};

export type Answer = {
  type: 'answer';
  program: 'live';
  id: number;
  tResp: number;
  modelMs: number;
  providerMs: number | null;
  inputTokens: number | null;
  costUsd: number | null;
  probabilities: Record<string, Probabilities>;
  confidence: Record<string, number> | null;
  /** What Jev's lean had usually been before this answer, per question (null inside: not known yet). Older pipelines send none. */
  lean?: Record<string, { usual: number | null; typical: number | null }> | null;
  /** Jev's signal per horizon (as answered, and with its usual lean taken out) and the simple rules, as recorded. */
  signals: Record<string, number | null>;
  midResp: number | null;
};

export type Fail = { type: 'fail'; program: 'live'; id: number; kind: 'rate-limit' | 'timeout' | 'error'; message: string };

// ---- news path ------------------------------------------------------------------------

export type NewsArrived = {
  type: 'news-item';
  program: 'news';
  id: string;
  source: string;
  sourceLabel: string;
  headline: string;
  url: string | null;
  publishedTs: number | null;
  recvTs: number;
  /** null: the source gave no tags, so the general-news route applies. */
  symbols: string[] | null;
};

export type NewsSkipReason = 'unpriceable' | 'repeat' | 'closed' | 'unpriced' | 'dropped' | 'lost';
export type NewsSkipped = { type: 'news-skip'; program: 'news'; id: string; reason: NewsSkipReason; detail: string };

export type NewsVerdict = {
  symbol: string;
  name: string;
  relevant: number;
  direction: Record<string, number>;
  magnitude: number;
  signal: number;
  mid: number | null;
  spreadBps: number | null;
};

export type NewsAnswered = {
  type: 'news-answer';
  program: 'news';
  id: string;
  tResp: number;
  queueMs: number;
  modelMs: number;
  providerMs: number | null;
  costUsd: number | null;
  attempts: number;
  novel: number;
  verdicts: NewsVerdict[];
  /** What Jev was shown. */
  state: unknown;
};

/** A call failed and the item is going back in line. */
export type NewsRetry = { type: 'news-retry'; program: 'news'; id: string; kind: 'rate-limit' | 'failure'; message: string };

export type TelemetryBody = Pulse | Ask | Answer | Fail | NewsArrived | NewsSkipped | NewsAnswered | NewsRetry;
export type TelemetryEvent = TelemetryBody & Envelope;

/** What the engines are given: they describe what happened, the sender adds the envelope. */
export type Emit = (body: TelemetryBody) => void;
