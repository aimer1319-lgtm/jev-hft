// Live paper pipeline: Coinbase feed -> state -> Jev -> decision log. No orders are sent.
//
//   npm run live                                   # gateway, run until Ctrl-C
//   JEV_PROVIDER=mock RUN_MINUTES=5 npm run live   # full pipeline, simulated model

import { mkdirSync, createWriteStream } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { config } from './config.ts';
import { coinbaseFeed } from './feed/coinbase.ts';
import { LiveEngine } from './engine.ts';
import { fileStamp, log, onStop } from './lib/run.ts';
import { summarize } from './lib/stats.ts';
import { createModel, keepWarm } from './model/jev.ts';

mkdirSync('data/decisions', { recursive: true });
const file = `data/decisions/live-${config.provider}-${fileStamp()}.jsonl`;
const out = createWriteStream(file);

const engine = new LiveEngine(createModel(config.provider), rec => out.write(JSON.stringify(rec) + '\n'), log);
const stopWarm = keepWarm(config.provider, log); // matters when decisions are more than a few seconds apart

// Per-window measurements of the data side: feed lag and event processing cost.
let events = 0;
let lags: number[] = [];
let applyUs: number[] = [];

const feed = coinbaseFeed(
  config.product,
  e => {
    const t0 = performance.now();
    engine.onEvent(e);
    applyUs.push((performance.now() - t0) * 1000);
    events++;
    if (e.type !== 'reset') lags.push(e.recvTs - e.exchTs);
  },
  log,
);

log(
  `live ${config.product} provider=${config.provider} encoding=${config.encoding} warmup=${config.warmupMs / 1000}s ` +
    `spacing>=${config.minIntervalMs}ms flat=${config.flatSigmas > 0 ? `${config.flatSigmas} x typical move` : 'fixed'} -> ${file}`,
);

const STATUS_MS = 10_000;
const status = setInterval(() => {
  const s = engine.stats;
  const lag = summarize(lags);
  const ap = summarize(applyUs);
  log(
    `mid ${engine.state.book.mid.toFixed(2)}  ev/s ${(events / (STATUS_MS / 1000)).toFixed(0)}  feed lag p50 ${lag.p50.toFixed(0)}ms  ` +
      `event cost p50 ${ap.p50.toFixed(0)}µs p99 ${ap.p99.toFixed(0)}µs  decisions ${s.decisions}  written ${s.written}  ` +
      `model ${Number.isFinite(s.lastModelMs) ? s.lastModelMs.toFixed(0) + 'ms' : '-'}  429s ${s.rateLimited}  timeouts ${s.timeouts}  errors ${s.errors}  cost $${s.costUsd.toFixed(4)}`,
  );
  events = 0;
  lags = [];
  applyUs = [];
}, STATUS_MS);

onStop(() => {
  clearInterval(status);
  stopWarm();
  feed.close();
  engine.flush(Infinity, true); // horizons that have not elapsed are recorded as unknown
  out.end(() => {
    log(`wrote ${engine.stats.written} decisions to ${file}`);
    process.exit(0);
  });
}, config.runMs);
