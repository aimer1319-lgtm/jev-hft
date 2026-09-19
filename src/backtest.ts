// Offline evaluation on recorded data. Replays events, snapshots the state every
// STEP_S seconds, asks Jev about each snapshot (in parallel: offline there is no
// latency budget), then scores answers as if they arrived BT_LATENCY_MS later.
// Separates "does Jev see anything?" from "can we act on it in time?".
//
//   npm run backtest -- data/raw/BTC-USD-<ts>.jsonl.gz
//   STEP_S=2 BT_LATENCY_MS=375 BT_CONCURRENCY=8 BT_MAX=2000 npm run backtest -- <file>

import { createReadStream, createWriteStream, mkdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { config, envNum } from './config.ts';
import { baselineSignals, fillForward, jevSignals, type DecisionRecord } from './engine.ts';
import type { MarketEvent } from './feed/types.ts';
import { encode } from './market/encode.ts';
import { MarketState, type Features } from './market/state.ts';
import { createModel, decide, RateLimitedError } from './model/jev.ts';

const file = process.argv[2];
if (!file) throw new Error('usage: npm run backtest -- <recorded .jsonl[.gz]>');

const stepMs = envNum('STEP_S', 5, { min: 0.01 }) * 1000;
const latencyMs = envNum('BT_LATENCY_MS', 375, { min: 0 });
const concurrency = envNum('BT_CONCURRENCY', 4, { min: 1 });
const maxSnapshots = envNum('BT_MAX', Infinity, { min: 1 });

// 1. Replay and snapshot. Each snapshot sees only events received before its time.
type Snapshot = { tState: number; f: Features; text: string; buildMs: number };
const state = new MarketState(Infinity);
let snaps: Snapshot[] = [];
let next = NaN;

const input = createReadStream(file).pipe(file.endsWith('.gz') ? createGunzip() : new PassThrough());
for await (const line of createInterface({ input, crlfDelay: Infinity })) {
  if (!line) continue;
  const e = JSON.parse(line) as MarketEvent;
  while (state.ready && e.recvTs >= next) {
    const t0 = performance.now();
    const f = state.features(next);
    const text = encode(f, state, config.product, config.encoding);
    snaps.push({ tState: next, f, text, buildMs: performance.now() - t0 });
    next += stepMs;
  }
  state.apply(e);
  if (!state.ready) next = NaN;
  else if (Number.isNaN(next)) next = e.recvTs + config.warmupMs;
}
const total = snaps.length;
if (snaps.length > maxSnapshots) {
  const stride = snaps.length / maxSnapshots;
  snaps = Array.from({ length: maxSnapshots }, (_, i) => snaps[Math.floor(i * stride)]!);
}
console.error(`replayed ${file}: ${total} snapshots every ${stepMs / 1000}s, evaluating ${snaps.length} with ${config.provider}`);

// 2. Evaluate with bounded concurrency; wait out rate limits rather than dropping snapshots.
const model = createModel(config.provider);
const records: DecisionRecord[] = [];
let cursor = 0;
let rateLimited = 0;
let failed = 0;

async function worker() {
  while (cursor < snaps.length) {
    const s = snaps[cursor++]!;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await decide(model, s.text);
        const rec: DecisionRecord = {
          mode: 'backtest',
          provider: config.provider,
          tState: s.tState,
          exchLagMs: s.tState - s.f.exchTs,
          buildMs: s.buildMs,
          modelMs: latencyMs,
          tResp: s.tState + latencyMs,
          inputTokens: res.inputTokens,
          state: s.text,
          probabilities: res.probabilities,
          signals: { ...jevSignals(res.probabilities), ...baselineSignals(s.f) },
          midState: s.f.mid,
          midResp: state.midAt(s.tState + latencyMs),
          fwdState: {},
          fwdResp: {},
        };
        fillForward(rec, state);
        records.push(rec);
        if (records.length % 50 === 0) console.error(`  ${records.length}/${snaps.length} evaluated`);
        break;
      } catch (error) {
        if (error instanceof RateLimitedError && attempt < 30) {
          rateLimited++;
          await new Promise(r => setTimeout(r, Math.min(5000 * 2 ** attempt, 60_000)));
          continue;
        }
        failed++;
        console.error(`  snapshot ${new Date(s.tState).toISOString()} failed: ${(error as Error).message}`);
        break;
      }
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));

mkdirSync('data/decisions', { recursive: true });
const outFile = `data/decisions/backtest-${config.provider}-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
const out = createWriteStream(outFile);
for (const r of records.sort((a, b) => a.tState - b.tState)) out.write(JSON.stringify(r) + '\n');
out.end(() => console.error(`wrote ${records.length} decisions (${failed} failed, ${rateLimited} rate-limit waits) to ${outFile}`));
