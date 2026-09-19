import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { recorder } from '../src/feed/recorder.ts';
import type { MarketEvent } from '../src/feed/types.ts';

const T0 = 1_800_000_000_000;
const events: MarketEvent[] = [
  { type: 'book', snapshot: true, updates: [{ side: 'bid', price: 99.5, size: 2 }, { side: 'ask', price: 100.5, size: 1 }], exchTs: T0 - 40, recvTs: T0 },
  { type: 'trade', price: 100, size: 0.25, aggressor: 'buy', exchTs: T0 + 460, recvTs: T0 + 500 },
  { type: 'reset', recvTs: T0 + 1000 },
];

test('a recording holds every event and is complete once closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-recorder-'));
  try {
    const rec = recorder('BTC-USD', dir);
    assert.match(rec.file, /^.*BTC-USD-\d{4}-\d{2}-\d{2}T.*\.jsonl\.gz$/);
    for (const e of events) rec.write(e);
    assert.equal(rec.events, 3);
    await rec.close();
    // Reading it back is the real check: a gzip stream that was not finished properly
    // decompresses to nothing, or to a truncated last line.
    const lines = gunzipSync(readFileSync(rec.file)).toString().split('\n').filter(Boolean);
    assert.deepEqual(lines.map(l => JSON.parse(l)), events, 'every event, unchanged and in order');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
