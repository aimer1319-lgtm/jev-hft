// Jev latency benchmark, for either route to the model.
//
// Decomposes a round trip into: edge RTT (TCP connect), the hop's own round trip (a request
// rejected before any model runs), and full model round trip, then varies connection reuse,
// state size, question count, and concurrency. Raw HTTPS is used for phase timing; one scenario
// goes through the AI SDK to measure its overhead.
//
//   npm run bench                     # whichever route JEV_PROVIDER selects (default: both)
//   BENCH_ROUTE=typesafe npm run bench
//   BENCH_N=40 npm run bench          # more samples per scenario
//
// Running both routes back to back is how the choice between them was made (docs/decisions.md
// D52): same questions, same machine, same minute. Each is about 170 real requests, roughly half
// a cent at list price.
//
// Each successful response also says how long Jev itself took, printed as "jev p50": the rest of
// the round trip is getting there and back. The gateway reports how long it waited for TypeSafe;
// TypeSafe's own API reports its service time in a header.

import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { experimental_evaluate, type Experimental_EvaluationQuestion as Question } from 'ai';
import { envNum } from '../src/config.ts';
import { summarize, fmtMs } from '../src/lib/stats.ts';
import { closeConnections, createModel } from '../src/model/jev.ts';

/** How to reach Jev one way, in the shape the SDK posts internally. */
type Route = {
  name: string;
  endpoint: URL;
  model: string;
  /** A model id this route turns down without running anything, to time the hop by itself. */
  unknown: string;
  ready: string | undefined;
  headers: (modelId: string, length: number) => Record<string, string | number>;
  body: (state: unknown, questions: unknown, modelId: string) => string;
  /** How long Jev itself took, as this route reports it. */
  jevMs: (json: Record<string, any>, headers: Record<string, string | string[] | undefined>) => number | undefined;
};

const ROUTES: Record<string, Route> = {
  typesafe: {
    name: 'typesafe',
    endpoint: new URL('https://api.typesafe.ai/v1/systemone'),
    model: 'jev-latest',
    unknown: 'jev-does-not-exist',
    ready: process.env.TYPESAFE_AI_API_KEY,
    headers: (_modelId, length) => ({
      Authorization: `Bearer ${process.env.TYPESAFE_AI_API_KEY}`,
      'Content-Type': 'application/json',
      'Content-Length': length,
    }),
    // The API calls a yes/no question "noul"; the SDK renames it on the way out, and so must we.
    body: (state, questions, modelId) =>
      JSON.stringify({
        model: modelId,
        state,
        questions: Object.fromEntries(
          Object.entries(questions as Record<string, { type: string }>).map(([id, q]) => [id, q.type === 'boolean' ? { ...q, type: 'noul' } : q]),
        ),
      }),
    jevMs: (_json, headers) => {
      const ms = Number(headers['x-envoy-upstream-service-time']);
      return Number.isFinite(ms) ? ms : undefined;
    },
  },
  gateway: {
    name: 'gateway',
    endpoint: new URL('https://ai-gateway.vercel.sh/v4/ai/evaluation-model'),
    model: process.env.AI_GATEWAY_MODEL || 'typesafe-ai/jev',
    unknown: 'typesafe-ai/does-not-exist',
    ready: process.env.AI_GATEWAY_API_KEY,
    headers: (modelId, length) => ({
      Authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}`,
      'Content-Type': 'application/json',
      'Content-Length': length,
      'ai-gateway-protocol-version': '0.0.1',
      'ai-gateway-auth-method': 'api-key',
      'ai-evaluation-model-specification-version': '4',
      'ai-model-id': modelId,
    }),
    body: (state, questions) => JSON.stringify({ state, questions }),
    jevMs: json => {
      const attempt = json.providerMetadata?.gateway?.routing?.modelAttempts?.at(-1)?.providerAttempts?.at(-1);
      return attempt?.startTime && attempt?.endTime ? attempt.endTime - attempt.startTime : undefined;
    },
  },
};

const wanted = (process.env.BENCH_ROUTE || process.env.JEV_PROVIDER || 'typesafe,gateway').split(/[\s,]+/).filter(Boolean);
const unknownRoute = wanted.find(r => !ROUTES[r]);
if (unknownRoute) throw new Error(`BENCH_ROUTE "${unknownRoute}" is not a route (${Object.keys(ROUTES).join(' | ')})`);
const selected = wanted.map(r => ROUTES[r]!).filter(r => {
  if (r.ready) return true;
  console.log(`skipping ${r.name}: its key is not set`);
  return false;
});
if (selected.length === 0) throw new Error('no route has a key set (TYPESAFE_AI_API_KEY or AI_GATEWAY_API_KEY)');

const N = envNum('BENCH_N', 20, { min: 1 });

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
  /** How long Jev itself took, as the route reports it; the rest of `total` is getting there and back. */
  providerMs?: number;
  error?: string;
};

function post(route: Route, agent: https.Agent, payload: { state: unknown; questions: unknown }, modelId = route.model): Promise<Sample> {
  const body = route.body(payload.state, payload.questions, modelId);
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    let reused = true;
    let connect: number | undefined;
    let tls: number | undefined;
    const req = https.request(
      route.endpoint,
      { method: 'POST', agent, headers: route.headers(modelId, Buffer.byteLength(body)) },
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
            // The gateway answers in the SDK's own shape, TypeSafe in its API's.
            inputTokens = json.usage?.inputTokens ?? json.usage?.input_tokens;
            providerMs = route.jevMs(json, res.headers);
          } catch {}
          resolve({
            ok: status === 200,
            status,
            reused,
            connect,
            tls,
            ttfb,
            total,
            route: (res.headers['x-vercel-id'] ?? res.headers['x-typesafe-request-id']) as string | undefined,
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

type Payload = { state: unknown; questions: unknown };
const payload = (state: unknown, questions: unknown): Payload => ({ state, questions });

// ---- runner ---------------------------------------------------------------------

async function sequential(route: Route, name: string, agent: https.Agent, p: Payload, n = N, warmup = 2, modelId = route.model) {
  for (let i = 0; i < warmup; i++) await post(route, agent, p, modelId);
  const samples: Sample[] = [];
  for (let i = 0; i < n; i++) samples.push(await post(route, agent, p, modelId));
  report(name, samples);
  return samples;
}

/** Collected per route so the summary at the end can put them side by side. */
const headline = new Map<string, number>();

function report(name: string, samples: Sample[]) {
  const ok = samples.filter(s => s.ok);
  const rejected = samples.filter(s => !s.ok);
  const tokens = ok.find(x => x.inputTokens != null)?.inputTokens;
  const where = samples[samples.length - 1]?.route?.split('::').slice(0, 2).join('>') ?? '';
  const line = (label: string, xs: Sample[]) => {
    const s = summarize(xs.map(x => x.total));
    return `${label.padEnd(30)} n=${String(xs.length).padStart(3)}  p50 ${fmtMs(s.p50)}  p90 ${fmtMs(s.p90)}  p99 ${fmtMs(s.p99)}  min ${fmtMs(s.min)}  max ${fmtMs(s.max)}`;
  };
  const jev = summarize(ok.map(x => x.providerMs ?? NaN).filter(Number.isFinite));
  if (ok.length) console.log(`${line(name, ok)}  tok ${String(tokens ?? '-').padStart(5)}  jev p50 ${fmtMs(jev.p50)}  ${where}`);
  // Rejections (429 rate limit, 404 unknown model) are answered without any model running,
  // so their round trip is what the hop itself costs.
  if (rejected.length) {
    const codes = [...new Set(rejected.map(r => r.status))].join(',');
    console.log(`${line(`${name} [rejected ${codes}]`, rejected)}  ${where}`);
  }
}

const warmAgent = () => new https.Agent({ keepAlive: true, maxSockets: 32 });

for (const route of selected) {
  console.log(`\n=== ${route.name}  model ${route.model}  endpoint ${route.endpoint.host}  n=${N} per scenario ===\n`);

  // 1. Cold: fresh TCP+TLS every request. TCP connect time ~= one RTT to the edge.
  {
    const samples: Sample[] = [];
    for (let i = 0; i < Math.min(N, 10); i++) {
      const agent = new https.Agent({ keepAlive: false });
      samples.push(await post(route, agent, payload(SMALL, Q1)));
      agent.destroy();
    }
    report('cold (new TLS each)', samples);
    const c = summarize(samples.map(s => s.connect ?? NaN).filter(Number.isFinite));
    const t = summarize(samples.map(s => (s.tls ?? NaN) - (s.connect ?? NaN)).filter(Number.isFinite));
    console.log(`${''.padEnd(30)} edge TCP connect (≈1 RTT) p50 ${fmtMs(c.p50)}   TLS handshake p50 ${fmtMs(t.p50)}`);
  }

  // 2. The hop by itself: an unknown model id is turned down before any model runs.
  {
    const agent = warmAgent();
    await sequential(route, `${route.name}-only (unknown model)`, agent, payload(SMALL, Q1), Math.min(N, 10), 1, route.unknown);
    agent.destroy();
  }

  // 3. Warm connection, varying question count and state size.
  {
    const agent = warmAgent();
    const warm = await sequential(route, 'warm 1q small', agent, payload(SMALL, Q1));
    const ok = warm.filter(s => s.ok);
    if (ok.length) headline.set(route.name, summarize(ok.map(s => s.total)).p50);
    await sequential(route, 'warm 4q small', agent, payload(SMALL, Q4));
    await sequential(route, 'warm 16q small', agent, payload(SMALL, Q16));
    await sequential(route, 'warm 1q medium', agent, payload(MEDIUM, Q1));
    await sequential(route, 'warm 1q large', agent, payload(LARGE, Q1));
    agent.destroy();
  }

  // 4. Concurrency: 8 in flight at once, several rounds.
  {
    const agent = warmAgent();
    await Promise.all(Array.from({ length: 8 }, () => post(route, agent, payload(SMALL, Q1))));
    const samples: Sample[] = [];
    for (let round = 0; round < Math.max(3, Math.ceil(N / 8)); round++) {
      samples.push(...(await Promise.all(Array.from({ length: 8 }, () => post(route, agent, payload(SMALL, Q1))))));
    }
    report('warm 1q small x8 parallel', samples);
    agent.destroy();
  }

  // 5. Same request the way the pipeline makes it: through the AI SDK, on its own warm connection.
  {
    const model = createModel(route.name);
    const run = () => experimental_evaluate({ model, state: SMALL, questions: Q1, maxRetries: 0 });
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
}

// Both routes, one number each: the warm single-question round trip, which is what a decision
// actually waits for.
if (headline.size > 1) {
  console.log('\nwarm 1q, the round trip a decision waits for:');
  const best = Math.min(...headline.values());
  for (const [name, p50] of [...headline].sort((a, b) => a[1] - b[1])) {
    const gap = p50 - best;
    console.log(`  ${name.padEnd(10)} p50 ${fmtMs(p50)}${gap > 0 ? `   ${fmtMs(gap)} slower (${((gap / p50) * 100).toFixed(0)}% of it)` : '   fastest'}`);
  }
}

await closeConnections();
