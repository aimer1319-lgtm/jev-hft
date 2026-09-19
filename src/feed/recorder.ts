// Saves normalized market events to a compressed file, one JSON object per line, for later
// replay by `backtest`. Used by `record` (whose only job this is) and, with RECORD=1, by `live`.

import { createWriteStream, mkdirSync } from 'node:fs';
import { createGzip } from 'node:zlib';
import { fileStamp } from '../lib/run.ts';
import type { MarketEvent } from './types.ts';

export type Recorder = {
  /** Where the events are being written. */
  readonly file: string;
  readonly events: number;
  write(e: MarketEvent): void;
  /** Finish the file. The promise resolves once everything is safely on disk. */
  close(): Promise<void>;
};

export function recorder(product: string, dir = 'data/raw'): Recorder {
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/${product}-${fileStamp()}.jsonl.gz`;
  const gz = createGzip();
  // Compressed output reaches the file through the gzip stream, so the file is only complete
  // once the sink says so; ending the gzip stream alone is not enough.
  const sink = gz.pipe(createWriteStream(file));
  let events = 0;

  return {
    file,
    get events() {
      return events;
    },
    write(e) {
      gz.write(JSON.stringify(e) + '\n');
      events++;
    },
    close() {
      return new Promise(resolve => {
        sink.on('finish', () => resolve());
        gz.end();
      });
    },
  };
}
