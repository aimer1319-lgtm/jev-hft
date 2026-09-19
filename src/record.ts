// Record the normalized Coinbase feed to gzipped JSONL for offline backtests.
//
//   RUN_MINUTES=60 npm run record

import { createWriteStream, mkdirSync } from 'node:fs';
import { createGzip } from 'node:zlib';
import { config } from './config.ts';
import { coinbaseFeed } from './feed/coinbase.ts';

mkdirSync('data/raw', { recursive: true });
const file = `data/raw/${config.product}-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl.gz`;
const gz = createGzip();
const sink = gz.pipe(createWriteStream(file));

let events = 0;
const feed = coinbaseFeed(config.product, e => {
  gz.write(JSON.stringify(e) + '\n');
  events++;
});
console.error(`recording ${config.product} -> ${file}`);
const status = setInterval(() => console.error(`${new Date().toISOString().slice(11, 19)} ${events} events`), 30_000);

let stopping = false;
const stop = () => {
  if (stopping) return; // a second signal (e.g. from systemd) while records are being saved
  stopping = true;
  clearInterval(status);
  feed.close();
  sink.on('finish', () => {
    console.error(`wrote ${events} events to ${file}`);
    process.exit(0);
  });
  gz.end();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
if (config.runMs > 0) setTimeout(stop, config.runMs);
