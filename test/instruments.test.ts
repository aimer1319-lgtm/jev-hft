import assert from 'node:assert/strict';
import { test } from 'node:test';
import { usSession } from '../src/market/sessions.ts';
import { instrument, normalizeCashtag, normalizeSymbol, route, sessionOf } from '../src/news/instruments.ts';
import type { NewsItem } from '../src/news/types.ts';

const item = (symbols?: string[]): NewsItem => ({ id: 'a', source: 's', headline: 'h', recvTs: 0, ...(symbols ? { symbols } : {}) });

test('routing: tags win, no tags means the macro route, empty tags means nothing we can price', () => {
  assert.deepEqual(route(item(['AAPL', 'MSFT']), 3, ['SPY', 'BTC-USD']), ['AAPL', 'MSFT']);
  assert.deepEqual(route(item(), 3, ['SPY', 'BTC-USD']), ['SPY', 'BTC-USD']);
  assert.deepEqual(route(item([]), 3, ['SPY', 'BTC-USD']), []);
  assert.deepEqual(route(item(['A', 'B', 'A', 'C', 'D']), 3, []), ['A', 'B', 'C'], 'deduplicated, then capped');
});

test('a publisher\'s ticker tags: Bitcoin in its spellings, US tickers, nothing else', () => {
  for (const s of ['BTC', 'btcusd', 'BTC-USD', 'BTC/USD']) assert.equal(normalizeSymbol(s), 'BTC-USD');
  assert.equal(normalizeSymbol(' aapl '), 'AAPL');
  assert.equal(normalizeSymbol('BRK.B'), 'BRK.B');
  assert.equal(normalizeSymbol('ETHUSD'), undefined, 'a crypto pair we have no prices for');
  assert.equal(normalizeSymbol('TOOLONG'), undefined);
  assert.equal(normalizeSymbol('LINK'), 'LINK', 'from a publisher this is the stock');
});

test('a cashtag typed by a person: crypto symbols are not mistaken for the stocks that share their letters', () => {
  assert.equal(normalizeCashtag('ETH'), undefined);
  assert.equal(normalizeCashtag('sol'), undefined);
  assert.equal(normalizeCashtag('LINK'), undefined);
  assert.equal(normalizeCashtag('BTC'), 'BTC-USD');
  assert.equal(normalizeCashtag('AAPL'), 'AAPL');
});

test('instruments are named so the model knows what is being asked about', () => {
  assert.deepEqual(instrument('BTC-USD'), { symbol: 'BTC-USD', assetClass: 'crypto', name: 'Bitcoin' });
  assert.equal(instrument('SPY').name, 'the S&P 500 index (SPY ETF)');
  assert.equal(instrument('AAPL').name, 'AAPL stock', 'no company list loaded');
  const names = (t: string) => (t === 'AAPL' ? 'Apple Inc.' : undefined);
  assert.equal(instrument('AAPL', names).name, 'Apple Inc. (AAPL)');
  assert.equal(instrument('ZZZZ', names).name, 'ZZZZ stock');
  assert.equal(instrument('SPY', () => 'SPDR S&P 500 ETF TRUST').name, 'the S&P 500 index (SPY ETF)', 'an index fund keeps its plain description');
});

test('US sessions follow New York time, including daylight saving', () => {
  const at = (iso: string) => usSession(Date.parse(iso));
  // Summer: New York is UTC-4.
  assert.equal(at('2026-07-15T07:59:00Z'), 'closed'); // 03:59
  assert.equal(at('2026-07-15T08:00:00Z'), 'pre'); // 04:00
  assert.equal(at('2026-07-15T13:29:00Z'), 'pre'); // 09:29
  assert.equal(at('2026-07-15T13:30:00Z'), 'regular'); // 09:30
  assert.equal(at('2026-07-15T19:59:00Z'), 'regular'); // 15:59
  assert.equal(at('2026-07-15T20:00:00Z'), 'post'); // 16:00
  assert.equal(at('2026-07-15T23:59:00Z'), 'post'); // 19:59
  assert.equal(at('2026-07-16T00:00:00Z'), 'closed'); // 20:00
  // Winter: New York is UTC-5, so the same UTC time is an hour earlier there.
  assert.equal(at('2026-01-14T13:30:00Z'), 'pre'); // 08:30
  assert.equal(at('2026-01-14T14:30:00Z'), 'regular'); // 09:30
  assert.equal(at('2026-01-14T21:00:00Z'), 'post'); // 16:00
  // Weekends, judged in New York: Friday 23:00 there is already Saturday in UTC.
  assert.equal(at('2026-07-18T15:00:00Z'), 'closed'); // Saturday
  assert.equal(at('2026-07-19T15:00:00Z'), 'closed'); // Sunday
  assert.equal(at('2026-07-18T03:00:00Z'), 'closed'); // Friday 23:00 in New York: after hours, closed
  assert.equal(at('2026-07-20T01:00:00Z'), 'closed'); // Sunday 21:00 in New York
});

test('Bitcoin never closes', () => {
  assert.equal(sessionOf(instrument('BTC-USD'), Date.parse('2026-07-18T15:00:00Z')), '24/7');
  assert.equal(sessionOf(instrument('AAPL'), Date.parse('2026-07-18T15:00:00Z')), 'closed');
});
