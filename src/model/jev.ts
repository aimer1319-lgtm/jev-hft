// The decision stage. `ask` wraps experimental_evaluate with pipeline semantics and is
// shared by the microstructure path (`decide`, below) and the news path (src/news).
//
// JEV_PROVIDER selects the route:
//   gateway  (default) Vercel AI Gateway, model AI_GATEWAY_MODEL (default typesafe-ai/jev)
//   typesafe           TypeSafe API directly (TYPESAFE_AI_API_KEY); skips the gateway hop
//   mock               random answers after MOCK_LATENCY_MS; exercises the pipeline for free

import { typeSafeAi } from '@ai-sdk/typesafe-ai';
import {
  experimental_evaluate,
  type Experimental_EvaluationModel as EvaluationModel,
  type Experimental_EvaluationQuestion as Question,
} from 'ai';
import { performance } from 'node:perf_hooks';
import { envNum } from '../config.ts';

export class RateLimitedError extends Error {}

type EvaluationState = Parameters<typeof experimental_evaluate>[0]['state'];

/** One Jev call. No retries (a retried answer is a stale answer); HTTP 429 becomes RateLimitedError. */
export async function ask<const Q extends Record<string, Question>>(
  model: EvaluationModel,
  state: EvaluationState,
  questions: Q,
  abortSignal?: AbortSignal,
) {
  try {
    return await experimental_evaluate({ model, state, questions, maxRetries: 0, abortSignal });
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 429) throw new RateLimitedError((error as Error).message);
    throw error;
  }
}

export function createModel(provider = process.env.JEV_PROVIDER || 'gateway'): EvaluationModel {
  switch (provider) {
    case 'gateway':
      return process.env.AI_GATEWAY_MODEL || 'typesafe-ai/jev';
    case 'typesafe':
      return typeSafeAi.evaluationModel('jev-latest');
    case 'mock':
      return mockModel(envNum('MOCK_LATENCY_MS', 375, { min: 0 }));
    default:
      throw new Error(`Unknown JEV_PROVIDER "${provider}" (gateway | typesafe | mock)`);
  }
}

// ---- microstructure questions ----------------------------------------------------

const direction = (seconds: number, flatBps: number): Extract<Question, { type: 'choice' }> => ({
  type: 'choice',
  instructions: `Based on this order book and trade flow snapshot, where will the mid price be ${seconds} seconds from now, relative to the current mid?`,
  criteria: {
    up: `Higher by more than ${flatBps} basis points`,
    down: `Lower by more than ${flatBps} basis points`,
    flat: `Within ${flatBps} basis points of the current mid`,
  },
});

/** Direction questions: horizon and the move that counts as flat. The analyzer scores each. */
export const DIRECTIONS = {
  dir_2s: { seconds: 2, flatBps: 0.5 },
  dir_10s: { seconds: 10, flatBps: 1 },
  dir_60s: { seconds: 60, flatBps: 3 },
} as const;

export const QUESTIONS = {
  dir_2s: direction(DIRECTIONS.dir_2s.seconds, DIRECTIONS.dir_2s.flatBps),
  dir_10s: direction(DIRECTIONS.dir_10s.seconds, DIRECTIONS.dir_10s.flatBps),
  dir_60s: direction(DIRECTIONS.dir_60s.seconds, DIRECTIONS.dir_60s.flatBps),
} satisfies Record<keyof typeof DIRECTIONS, Question>;

export type Probabilities = Record<string, number>;
export type ModelResult = {
  probabilities: Record<keyof typeof QUESTIONS, Probabilities>;
  inputTokens?: number;
};

export async function decide(model: EvaluationModel, state: string, abortSignal?: AbortSignal): Promise<ModelResult> {
  const result = await ask(model, state, QUESTIONS, abortSignal);
  const probabilities = Object.fromEntries(
    Object.entries(result.answers).map(([id, a]) => [id, a.probabilities ?? { [a.choice]: 1 }]),
  ) as ModelResult['probabilities'];
  return { probabilities, inputTokens: result.usage.inputTokens };
}

/** P(up) - P(down): the directional signal extracted from a direction answer. */
export const directionSignal = (p: Probabilities) => (p.up ?? 0) - (p.down ?? 0);

// ---- mock -----------------------------------------------------------------------

function mockModel(latencyMs: number): EvaluationModel {
  const distribution = (n: number) => {
    const raw = Array.from({ length: n }, () => Math.random());
    const sum = raw.reduce((a, b) => a + b, 0);
    return raw.map(x => x / sum);
  };
  return {
    specificationVersion: 'v4',
    provider: 'mock',
    modelId: 'mock-jev',
    supportedQuestionTypes: ['choice', 'score', 'boolean'],
    async doEvaluate({ questions, abortSignal }) {
      const t0 = performance.now();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, latencyMs * (0.8 + 0.4 * Math.random()));
        abortSignal?.addEventListener('abort', () => (clearTimeout(timer), reject(abortSignal.reason)));
      });
      const answers = Object.fromEntries(
        Object.entries(questions).map(([id, q]) => {
          if (q.type === 'boolean') return [id, { type: 'boolean' as const, probability: Math.random() }];
          const keys = q.type === 'choice' ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
          const p = distribution(keys.length);
          const probabilities = Object.fromEntries(keys.map((k, i) => [k, p[i]!]));
          if (q.type === 'score') return [id, { type: 'score' as const, score: p.reduce((s, x, i) => s + x * i, 0), probabilities }];
          return [id, { type: 'choice' as const, choice: keys[p.indexOf(Math.max(...p))]!, probabilities }];
        }),
      );
      return { answers, warnings: [], usage: { inputTokens: 0 }, response: { modelId: `mock-jev (${(performance.now() - t0).toFixed(0)}ms)` } };
    },
  };
}
