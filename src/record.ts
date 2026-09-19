// Record the normalized Coinbase feed to gzipped JSONL for offline backtests.
//
//   RUN_MINUTES=60 npm run record

import { createWriteStream, mkdirSync } from 'node:fs';
import { createGzip } from 'node:zlib';
import { config } from './config.ts';
import { coinbaseFeed } from './feed/coinbase.ts';
import { fileStamp, log, onStop } from './lib/run.ts';

mkdirSync('data/raw', { recursive: true });
const file = `data/raw/${config.product}-${fileStamp()}.jsonl.gz`;
const gz = createGzip();
const sink = gz.pipe(createWriteStream(file));

let events = 0;
const feed = coinbaseFeed(
  config.product,
  e => {
    gz.write(JSON.stringify(e) + '\n');
    events++;
  },
  log,
);
log(`recording ${config.product} -> ${file}`);
const status = setInterval(() => log(`${events} events`), 30_000);

onStop(() => {
  clearInterval(status);
  feed.close();
  sink.on('finish', () => {
    log(`wrote ${events} events to ${file}`);
    process.exit(0);
  });
  gz.end();
}, config.runMs);
