import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QuoteBook } from '../src/market/quotes.ts';

const T0 = 1_800_000_000_000;

test('quotes give a mid and a spread at any past moment', () => {
  const q = new QuoteBook(3600_000);
  q.update('AAPL', T0, 99.95, 100.05);
  q.update('AAPL', T0 + 1000, 100.9, 101.1);
  assert.ok(Number.isNaN(q.midAt('AAPL', T0 - 1)));
  assert.equal(q.midAt('AAPL', T0 + 999), 100);
  assert.equal(q.midAt('AAPL', T0 + 1000), 101);
  assert.ok(Math.abs(q.spreadAt('AAPL', T0) - 10) < 1e-6, '10 cents on $100 is 10 bp');
  assert.ok(Math.abs(q.spreadBps('AAPL') - (0.2 / 101) * 1e4) < 1e-6);
  assert.ok(Number.isNaN(q.mid('MSFT')), 'unknown symbol');
});

test('a wider quote with the same mid is still recorded, because the spread changed', () => {
  const q = new QuoteBook(3600_000);
  q.update('AAPL', T0, 99.95, 100.05);
  q.update('AAPL', T0 + 1000, 99, 101); // same mid, 200 bp wide
  assert.equal(q.midAt('AAPL', T0 + 1000), 100);
  assert.ok(q.spreadAt('AAPL', T0 + 1000) > 199);
  assert.ok(q.spreadAt('AAPL', T0 + 999) < 11);
});

test('one-sided, crossed, and out-of-order quotes are ignored', () => {
  const q = new QuoteBook(3600_000);
  q.update('AAPL', T0, 0, 100);
  q.update('AAPL', T0, 101, 100);
  assert.ok(Number.isNaN(q.mid('AAPL')));
  q.update('AAPL', T0 + 1000, 100, 100.1);
  q.update('AAPL', T0 + 500, 50, 50.1); // older than what we already have
  assert.equal(q.mid('AAPL'), 100.05);
});

test('a REST snapshot goes in front of streamed quotes, and only if nothing earlier is known', () => {
  const q = new QuoteBook(3600_000);
  q.update('AAPL', T0 + 300, 100, 100.2); // the stream was quicker than the REST call
  q.seed('AAPL', T0, 99.9, 100.1);
  assert.equal(q.midAt('AAPL', T0), 100);
  assert.equal(q.midAt('AAPL', T0 + 300), 100.1);
  q.seed('AAPL', T0 + 100, 1, 2); // something is already known before this
  assert.equal(q.midAt('AAPL', T0 + 100), 100);
});

test('minute bars fill in only the time before we started watching', () => {
  const q = new QuoteBook(3600_000);
  q.seed('AAPL', T0, 99.9, 100.1);
  q.seedHistory('AAPL', [
    { t: T0 - 120_000, price: 98 },
    { t: T0 - 60_000, price: 99 },
    { t: T0 + 60_000, price: 500 }, // not before what we know: ignored
  ]);
  assert.equal(q.midAt('AAPL', T0 - 90_000), 98);
  assert.equal(q.midAt('AAPL', T0 - 1), 99);
  assert.equal(q.midAt('AAPL', T0 + 120_000), 100);
  assert.ok(Number.isNaN(q.spreadAt('AAPL', T0 - 60_000)), 'bars carry no spread');
});

test('while the connection is down prices are unknown; afterwards the newest quote counts again', () => {
  const q = new QuoteBook(3600_000);
  q.update('AAPL', T0, 99.95, 100.05);
  q.markGap(T0 + 5000); // last message we got
  assert.ok(Number.isNaN(q.mid('AAPL')));
  assert.ok(Number.isNaN(q.midAt('AAPL', T0 + 6000)));
  assert.equal(q.midAt('AAPL', T0 + 5000), 100, 'up to the last message the price is known');
  q.markGap(T0 + 7000); // a second drop during the same outage keeps the first start
  q.update('AAPL', T0 + 9000, 101.95, 102.05); // refreshed just before quotes resume
  q.resume(T0 + 9100);
  assert.equal(q.mid('AAPL'), 102);
  assert.ok(Number.isNaN(q.midAt('AAPL', T0 + 8000)));
  assert.equal(q.midAt('AAPL', T0 + 9100), 102);
});

test('dropping a symbol forgets it', () => {
  const q = new QuoteBook(3600_000);
  q.update('AAPL', T0, 99.95, 100.05);
  q.drop('AAPL');
  assert.ok(Number.isNaN(q.mid('AAPL')));
});
