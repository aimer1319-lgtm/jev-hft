// Jev latency benchmark through Vercel AI Gateway.
//
// Decomposes a round trip into: edge RTT (TCP connect), gateway-only round trip
// (a request the gateway rejects before calling the provider), and full model
// round trip, then varies connection reuse, state size, question count, and
// concurrency. Raw HTTPS is used for phase timing; one scenario goes through the
// AI SDK to measure its overhead.
//
//   npm run bench            # all scenarios
//   BENCH_N=40 npm run bench # more samples per scenario
//
// An AI Gateway account without credits is limited to about 5 requests per 5 minutes on this
// model; most requests then come back 429 and are reported as gateway-only timings. With
// credits, all of the roughly 170 requests go through (about half a cent at list price).
//
// Each successful response also says how long the gateway waited for TypeSafe, printed as
// "typesafe p50": the rest of the round trip is the network and the gateway itself.

import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { experimental_evaluate, type Experimental_EvaluationQuestion as Question } from 'ai';
import { envNum } from '../src/config.ts';
import { summarize, fmtMs } from '../src/lib/stats.ts';

const apiKey = process.env.AI_GATEWAY_API_KEY;
if (!apiKey) throw new Error('AI_GATEWAY_API_KEY is not set');

const MODEL = process.env.AI_GATEWAY_MODEL || 'typesafe-ai/jev';
const N = envNum('BENCH_N', 20, { min: 1 });
const ENDPOINT = new URL('https://ai-gateway.vercel.sh/v4/ai/evaluation-model');

type Sample = {
  ok: boolean;
  status: number;
  reused: boolean;
  connect?: number;
  tls?: number;
  ttfb: number;
  total: number;
  route?: string;
  inputTokens?: number;
  /** How long the gateway says it waited for TypeSafe; the rest of `total` is network and gateway. */
  providerMs?: number;
  error?: string;
};

function post(agent: https.Agent, body: string, modelId = MODEL): Promise<Sample> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    let reused = true;
    let connect: number | undefined;
    let tls: number | undefined;
    const req = https.request(
      ENDPOINT,
      {
        method: 'POST',
        agent,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'ai-gateway-protocol-version': '0.0.1',
          'ai-gateway-auth-method': 'api-key',
          'ai-evaluation-model-specification-version': '4',
          'ai-model-id': modelId,
        },
      },
      res => {
        const ttfb = performance.now() - t0;
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const total = performance.now() - t0;
          const text = Buffer.concat(chunks).toString();
          const status = res.statusCode ?? 0;
          let inputTokens: number | undefined;
          let providerMs: number | undefined;
          try {
            const json = JSON.parse(text);
            inputTokens = json.usage?.inputTokens;
            const attempt = json.providerMetadata?.gateway?.routing?.modelAttempts?.at(-1)?.providerAttempts?.at(-1);
            if (attempt?.startTime && attempt?.endTime) providerMs = attempt.endTime - attempt.startTime;
          } catch {}
          resolve({
            ok: status === 200,
            status,
            reused,
            connect,
            tls,
            ttfb,
            total,
            route: res.headers['x-vercel-id'] as string | undefined,
            inputTokens,
            providerMs,
            ...(status !== 200 ? { error: text.slice(0, 160) } : {}),
          });
        });
      },
    );
    req.on('socket', socket => {
      if (!socket.connecting) return;
      reused = false;
      socket.once('connect', () => (connect = performance.now() - t0));
      socket.once('secureConnect', () => (tls = performance.now() - t0));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// ---- synthetic states of increasing size -------------------------------------

function book(levels: number, mid = 64012.5, tick = 0.5) {
  const row = (side: 1 | -1, i: number) =>
    `${(mid + side * (tick / 2 + i * tick)).toFixed(1)}x${(0.05 + ((i * 7919) % 97) / 40).toFixed(3)}`;
  return {
    bids: Array.from({ length: levels }, (_, i) => row(-1, i)).join(' '),
    asks: Array.from({ length: levels }, (_, i) => row(1, i)).join(' '),
  };
}

function trades(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const side = (i * 31) % 3 === 0 ? 'S' : 'B';
    return `${side} ${(64012 + ((i * 13) % 9) * 0.5).toFixed(1)}x${(0.001 + ((i * 17) % 50) / 100).toFixed(3)} -${i * 120}ms`;
  }).join('; ');
}

const SMALL = 'BTC-USD mid 64012.5 spread 1.0bp. Returns: 1s +0.8bp, 5s +2.1bp, 30s -3.0bp. Book imbalance L1 +0.62, L5 +0.31. Trade flow 5s: buy 3.2 BTC (41 prints), sell 1.1 BTC (17 prints).';
const MEDIUM = { summary: SMALL, book: book(20), trades: trades(30) };
const LARGE = { summary: SMALL, book: book(100), trades: trades(150) };

// ---- questions ------------------------------------------------------------------

const direction = (h: string): Question => ({
  type: 'choice',
  instructions: `Will the BTC-USD mid price be higher, lower, or unchanged ${h} from now?`,
  criteria: { up: 'Higher by more than half a basis point', down: 'Lower by more than half a basis point', flat: 'Within half a basis point' },
});

const Q1 = { dir_10s: direction('10 seconds') } satisfies Record<string, Question>;
const Q4 = {
  dir_10s: direction('10 seconds'),
  pressure: { type: 'score', instructions: 'How one-sided is recent order flow?', criteria: ['Balanced', 'Moderately one-sided', 'Strongly one-sided'] },
  sweep: { type: 'boolean', instructions: 'Is an aggressive participant sweeping multiple book levels?' },
  regime: { type: 'choice', instructions: 'What is the current market regime?', criteria: { trending: null, mean_reverting: null, quiet: null } },
} satisfies Record<string, Question>;
const Q16: Record<string, Question> = Object.fromEntries(
  ['1s', '2s', '3s', '5s', '10s', '15s', '20s', '30s', '45s', '1m', '2m', '3m', '5m', '10m', '15m', '30m'].map(h => [
    `dir_${h}`,
    direction(`in ${h}`),
  ]),
);

const body = (state: unknown, questions: unknown) => JSON.stringify({ state, questions });

// ---- runner ---------------------------------------------------------------------

async function sequential(name: string, agent: https.Agent, payload: string, n = N, warmup = 2, modelId = MODEL) {
  for (let i = 0; i < warmup; i++) await post(agent, payload, modelId);
  const samples: Sample[] = [];
  for (let i = 0; i < n; i++) samples.push(await post(agent, payload, modelId));
  report(name, samples);
  return samples;
}

function report(name: string, samples: Sample[]) {
  const ok = samples.filter(s => s.ok);
  const rejected = samples.filter(s => !s.ok);
  const tokens = ok.find(x => x.inputTokens != null)?.inputTokens;
  const route = samples[samples.length - 1]?.route?.split('::').slice(0, 2).join('>') ?? '';
  const line = (label: string, xs: Sample[]) => {
    const s = summarize(xs.map(x => x.total));
    return `${label.padEnd(30)} n=${String(xs.length).padStart(3)}  p50 ${fmtMs(s.p50)}  p90 ${fmtMs(s.p90)}  p99 ${fmtMs(s.p99)}  min ${fmtMs(s.min)}  max ${fmtMs(s.max)}`;
  };
  const provider = summarize(ok.map(x => x.providerMs ?? NaN).filter(Number.isFinite));
  if (ok.length) console.log(`${line(name, ok)}  tok ${String(tokens ?? '-').padStart(5)}  typesafe p50 ${fmtMs(provider.p50)}  ${route}`);
  // Rejections (429 rate limit, 404 unknown model) are answered by the gateway without
  // calling the provider, so their round trip is the gateway's own overhead.
  if (rejected.length) {
    const codes = [...new Set(rejected.map(r => r.status))].join(',');
    console.log(`${line(`${name} [rejected ${codes}]`, rejected)}  ${route}`);
  }
}

const warmAgent = () => new https.Agent({ keepAlive: true, maxSockets: 32 });

console.log(`model ${MODEL}  endpoint ${ENDPOINT.host}  n=${N} per scenario\n`);

// 1. Cold: fresh TCP+TLS every request. TCP connect time ~= one RTT to the edge.
{
  const samples: Sample[] = [];
  for (let i = 0; i < Math.min(N, 10); i++) {
    const agent = new https.Agent({ keepAlive: false });
    samples.push(await post(agent, body(SMALL, Q1)));
    agent.destroy();
  }
  report('cold (new TLS each)', samples);
  const c = summarize(samples.map(s => s.connect ?? NaN).filter(Number.isFinite));
  const t = summarize(samples.map(s => (s.tls ?? NaN) - (s.connect ?? NaN)).filter(Number.isFinite));
  console.log(`${''.padEnd(30)} edge TCP connect (≈1 RTT) p50 ${fmtMs(c.p50)}   TLS handshake p50 ${fmtMs(t.p50)}`);
}

// 2. Gateway-only: unknown model id is rejected by the gateway before any provider call.
{
  const agent = warmAgent();
  await sequential('gateway-only (unknown model)', agent, body(SMALL, Q1), Math.min(N, 10), 1, 'typesafe-ai/does-not-exist');
  agent.destroy();
}

// 3. Warm connection, varying question count and state size.
{
  const agent = warmAgent();
  await sequential('warm 1q small', agent, body(SMALL, Q1));
  await sequential('warm 4q small', agent, body(SMALL, Q4));
  await sequential('warm 16q small', agent, body(SMALL, Q16));
  await sequential('warm 1q medium', agent, body(MEDIUM, Q1));
  await sequential('warm 1q large', agent, body(LARGE, Q1));
  agent.destroy();
}

// 4. Concurrency: 8 in flight at once, several rounds.
{
  const agent = warmAgent();
  await Promise.all(Array.from({ length: 8 }, () => post(agent, body(SMALL, Q1))));
  const samples: Sample[] = [];
  for (let round = 0; round < Math.max(3, Math.ceil(N / 8)); round++) {
    samples.push(...(await Promise.all(Array.from({ length: 8 }, () => post(agent, body(SMALL, Q1))))));
  }
  report('warm 1q small x8 parallel', samples);
  agent.destroy();
}

// 5. Same request through the AI SDK (default fetch, keep-alive via undici).
{
  const run = () => experimental_evaluate({ model: MODEL, state: SMALL, questions: Q1, maxRetries: 0 });
  const times: number[] = [];
  let failures = 0;
  for (let i = 0; i < N + 2; i++) {
    const t0 = performance.now();
    try {
      await run();
      if (i >= 2) times.push(performance.now() - t0); // first two warm the connection
    } catch {
      failures++;
    }
  }
  const s = summarize(times);
  console.log(
    `${'AI SDK 1q small'.padEnd(30)} n=${String(times.length).padStart(3)}  p50 ${fmtMs(s.p50)}  p90 ${fmtMs(s.p90)}  p99 ${fmtMs(s.p99)}  min ${fmtMs(s.min)}  max ${fmtMs(s.max)}${failures ? `  (${failures} failed)` : ''}`,
  );
}
