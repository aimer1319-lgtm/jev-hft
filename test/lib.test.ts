import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Backoff } from '../src/lib/backoff.ts';
import { backoffMs } from '../src/lib/poll.ts';
import { SeenSet } from '../src/lib/seen.ts';

test('rate-limit pauses double up to a minute, and several refusals at once are one event', () => {
  const b = new Backoff();
  assert.equal(b.waiting(0), false);
  assert.equal(b.fail(0), 5000);
  assert.equal(b.fail(1), 4999, 'a second refusal in the same pause does not lengthen it');
  assert.equal(b.waiting(4999), true);
  assert.equal(b.waiting(5000), false);
  assert.equal(b.fail(5000), 10_000);
  assert.equal(b.fail(15_000), 20_000);
  assert.equal(b.fail(35_000), 40_000);
  assert.equal(b.fail(75_000), 60_000, 'capped');
  b.succeed();
  assert.equal(b.fail(200_000), 5000);
});

test('feed polling backs off after failures, honors the server, and waits long when retrying is pointless', () => {
  const e = (extra = {}) => Object.assign(new Error('x'), extra);
  assert.equal(backoffMs(30_000, 1, e()), 60_000);
  assert.equal(backoffMs(30_000, 2, e()), 120_000);
  assert.equal(backoffMs(30_000, 9, e()), 300_000, 'capped at five minutes');
  assert.equal(backoffMs(30_000, 1, e({ retryAfterMs: 600_000 })), 600_000, 'the server asked for longer');
  assert.equal(backoffMs(30_000, 1, e({ fatal: true })), 600_000, 'a rejected key will not fix itself');
});

test('the seen set reports new ids once and forgets the oldest beyond its size', () => {
  const s = new SeenSet(3);
  assert.equal(s.add('a'), true);
  assert.equal(s.add('a'), false);
  s.add('b');
  s.add('c');
  s.add('d');
  assert.equal(s.has('a'), false, 'the oldest was forgotten');
  assert.equal(s.has('d'), true);
});
