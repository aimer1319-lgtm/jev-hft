// Record the normalized Coinbase feed to gzipped JSONL for offline backtests.
//
//   RUN_MINUTES=60 npm run record
//
// `npm run live` can do this at the same time as deciding (RECORD=1), which is the better
// choice when you want a recording of exactly what a live run saw.

import { config } from './config.ts';
import { coinbaseFeed } from './feed/coinbase.ts';
import { recorder } from './feed/recorder.ts';
import { log, onStop } from './lib/run.ts';

const rec = recorder(config.product);
const feed = coinbaseFeed(config.product, e => rec.write(e), log);
log(`recording ${config.product} -> ${rec.file}`);
const status = setInterval(() => log(`${rec.events} events`), 30_000);

onStop(() => {
  clearInterval(status);
  feed.close();
  void rec.close().then(() => {
    log(`wrote ${rec.events} events to ${rec.file}`);
    process.exit(0);
  });
}, config.runMs);
