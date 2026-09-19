import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OrderBook } from '../src/market/book.ts';

const levels = [
  { side: 'bid' as const, price: 100, size: 1 },
  { side: 'bid' as const, price: 99, size: 2 },
  { side: 'bid' as const, price: 98, size: 4 },
  { side: 'ask' as const, price: 101, size: 3 },
  { side: 'ask' as const, price: 102, size: 5 },
  { side: 'ask' as const, price: 103, size: 0 }, // empty levels in a snapshot are not levels
];

test('a snapshot gives the best prices, the mid, and levels counted from the touch', () => {
  const b = new OrderBook();
  assert.equal(b.ready, false);
  b.load(levels);
  assert.equal(b.ready, true);
  assert.equal(b.bestBid, 100);
  assert.equal(b.bestAsk, 101);
  assert.equal(b.mid, 100.5);
  assert.deepEqual(b.level('bid', 0), [100, 1]);
  assert.deepEqual(b.level('bid', 2), [98, 4]);
  assert.deepEqual(b.level('ask', 1), [102, 5]);
  assert.equal(b.level('ask', 2), undefined);
});

test('updates insert, change, and remove levels, and the best price follows', () => {
  const b = new OrderBook();
  b.load(levels);
  b.apply('bid', 100.5, 7); // a new best bid
  assert.equal(b.bestBid, 100.5);
  b.apply('bid', 100.5, 2); // same level, new size
  assert.deepEqual(b.level('bid', 0), [100.5, 2]);
  b.apply('bid', 100.5, 0); // gone
  assert.equal(b.bestBid, 100);
  b.apply('bid', 97, 0); // removing a level that does not exist changes nothing
  b.apply('ask', 100.75, 1); // asks are sorted the other way round
  assert.equal(b.bestAsk, 100.75);
  b.apply('ask', 150, 9); // far from the touch
  assert.deepEqual(b.level('ask', 3), [150, 9]);
});

test('size near the touch: by level count and by distance from the mid', () => {
  const b = new OrderBook();
  b.load(levels);
  assert.equal(b.topSize('bid', 1), 1);
  assert.equal(b.topSize('bid', 2), 3);
  assert.equal(b.topSize('bid', 10), 7); // fewer levels than asked for
  assert.equal(b.topSize('ask', 2), 8);
  // mid 100.5: 100 bp below is 99.495, so bids at 100 and 99 are outside... 99 is 149 bp away
  assert.equal(b.depthWithin('bid', 100), 1);
  assert.equal(b.depthWithin('bid', 200), 3);
  assert.equal(b.depthWithin('ask', 100), 3);
});

test('clear empties the book', () => {
  const b = new OrderBook();
  b.load(levels);
  b.clear();
  assert.equal(b.ready, false);
  assert.ok(Number.isNaN(b.mid));
});
