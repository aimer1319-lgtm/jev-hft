import assert from 'node:assert/strict';
import { test } from 'node:test';
import { usSession } from '../src/market/sessions.ts';
import { headlineNames, instrument, normalizeCashtag, normalizeSymbol, route, sessionOf } from '../src/news/instruments.ts';
import type { NewsItem } from '../src/news/types.ts';

const item = (symbols?: string[]): NewsItem => ({ id: 'a', source: 's', headline: 'h', recvTs: 0, ...(symbols ? { symbols } : {}) });

test('routing: tags win, no tags means the macro route, empty tags means nothing we can price', () => {
  assert.deepEqual(route(item(['AAPL', 'MSFT']), 3, ['SPY', 'BTC-USD']), ['AAPL', 'MSFT']);
  assert.deepEqual(route(item(), 3, ['SPY', 'BTC-USD']), ['SPY', 'BTC-USD']);
  assert.deepEqual(route(item([]), 3, ['SPY', 'BTC-USD']), []);
  assert.deepEqual(route(item(['A', 'B', 'A', 'C', 'D']), 3, []), ['A', 'B', 'C'], 'deduplicated, then capped');
});

const NAMES: Record<string, string> = {
  CRWD: 'CrowdStrike Holdings, Inc.',
  BUG: 'Global X Funds',
  CIBR: 'First Trust Exchange-Traded Fund VI',
  RCL: 'ROYAL CARIBBEAN CRUISES LTD',
  VOT: 'VANGUARD INDEX FUNDS',
  BBY: 'BEST BUY CO INC',
  AMZN: 'AMAZON COM INC',
  AAPL: 'Apple Inc.',
  AXP: 'AMERICAN EXPRESS CO',
  F: 'FORD MOTOR CO',
};
const names = (t: string) => NAMES[t];
const tagged = (headline: string, symbols: string[]): NewsItem => ({ id: 'a', source: 's', headline, recvTs: 0, symbols });

test('routing: funds the headline does not name are dropped when it names a company', () => {
  assert.deepEqual(route(tagged('CrowdStrike Stock Hits 52-Week High - Here\'s Why', ['CIBR', 'BUG', 'AIPI', 'CRWD']), 3, [], names), ['CRWD'], 'AIPI is not in the company list: a fund');
  assert.deepEqual(route(tagged('Royal Caribbean Sets Sights on $2 Trillion Vacation Market', ['VOT', 'CGDV', 'RCL']), 3, [], names), ['RCL']);
  assert.deepEqual(route(tagged('Best Buy, Amazon Deepen Fire TV Alliance', ['BBY', 'AMZN']), 3, [], names), ['BBY', 'AMZN'], 'both named, order kept');
  assert.deepEqual(route(tagged('Analyst upgrades AAPL on services growth', ['BUG', 'AAPL']), 3, [], names), ['AAPL'], 'named by ticker');
  assert.deepEqual(route(tagged('Apple raises guidance', ['AAPL', 'AMZN', 'BTC-USD', 'SPY']), 4, [], names), ['AAPL', 'AMZN', 'BTC-USD', 'SPY'], 'companies, Bitcoin and index funds stay');
});

test('routing: when nothing is named, funds go last; before the company list loads, nothing changes', () => {
  assert.deepEqual(route(tagged('Tech stocks rally into the close', ['BUG', 'CRWD', 'CIBR', 'AAPL']), 3, [], names), ['CRWD', 'AAPL', 'BUG']);
  assert.deepEqual(route(tagged('CrowdStrike Stock Hits 52-Week High', ['CIBR', 'BUG', 'CRWD']), 3, []), ['CIBR', 'BUG', 'CRWD'], 'no list given');
  assert.deepEqual(route(tagged('CrowdStrike Stock Hits 52-Week High', ['CIBR', 'BUG', 'CRWD']), 3, [], () => undefined), ['CIBR', 'BUG', 'CRWD'], 'list not loaded yet');
  assert.deepEqual(route(item(), 3, ['SPY', 'BTC-USD'], names), ['SPY', 'BTC-USD'], 'the macro route is left alone');
});

test('a headline names a company by ticker or by the distinctive start of its name, not by accident', () => {
  assert.equal(headlineNames('American Express beats estimates', 'AXP', NAMES.AXP), true, 'a generic first word needs the second');
  assert.equal(headlineNames('American Airlines cuts routes', 'AXP', NAMES.AXP), false);
  assert.equal(headlineNames('Is it time to buy a stock?', 'F', NAMES.F), false, 'one-letter tickers only as $F or (F)');
  assert.equal(headlineNames('Ford Motor (F) recalls trucks', 'F', NAMES.F), true);
  assert.equal(headlineNames('Applebee\'s owner reports', 'AAPL', NAMES.AAPL), false, 'whole words only');
  assert.equal(headlineNames('Bitcoin slips below $80K', 'BTC-USD', undefined), true);
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
