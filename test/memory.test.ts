import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecentNews, similarity, words } from '../src/news/memory.ts';
import type { NewsItem } from '../src/news/types.ts';

const T0 = 1_800_000_000_000;
let n = 0;
const item = (headline: string, minutes: number, source = 'wire'): NewsItem => ({ id: `m:${++n}`, source, headline, recvTs: T0 + minutes * 60_000 });

test('headlines are compared by their meaningful words, plural or not', () => {
  assert.deepEqual([...words('The Fed cuts rates by 50 basis points.')], ['fed', 'cut', 'rate', '50', 'basi', 'point']);
  assert.equal(similarity(words('Fed cuts rates'), words('fed cut rate')), 1);
  assert.equal(similarity(words('Fed cuts rates'), words('Apple beats estimates')), 0);
  assert.equal(similarity(new Set(), words('anything')), 0);
  assert.ok(similarity(words('Federal Reserve cuts interest rates by 50 basis points in unscheduled meeting'), words('Fed Announces Emergency 50 Basis Point Rate Cut')) > 0.3);
});

test('numbers keep different stories apart', () => {
  assert.ok(similarity(words('Apple Q3 EPS $1.40 beats $1.35 estimate'), words('Apple Q3 revenue $85B beats $84B estimate')) < 0.8);
});

test('a repeat is the same words about the same instrument within half an hour', () => {
  const m = new RecentNews();
  const first = item('Fed cuts interest rates by 50 basis points', 0);
  m.add(first, ['BTC-USD', 'SPY']);
  assert.equal(m.duplicateOf(item('Fed cuts interest rates by 50 basis points', 5, 'other-wire'), ['BTC-USD'])?.id, first.id);
  assert.equal(m.duplicateOf(item('Fed cuts interest rates by 50 basis points', 5), ['AAPL']), undefined, 'a different instrument');
  assert.equal(m.duplicateOf(item('Fed cuts interest rates by 50 basis points', 45), ['BTC-USD']), undefined, 'too long ago to be the same report');
  assert.equal(m.duplicateOf(item('Fed holds interest rates steady', 5), ['BTC-USD']), undefined, 'different news');
  assert.equal(m.duplicateOf(first, ['BTC-USD']), undefined, 'an item is not a repeat of itself');
});

test('earlier headlines: company news always relates; broad instruments need shared words', () => {
  const m = new RecentNews();
  m.add(item('Bitcoin miner reports record monthly production', 0), ['BTC-USD']);
  m.add(item('Fed issues FOMC statement: rates lowered by 50 basis points', 30, 'fed'), ['SPY', 'BTC-USD']);
  m.add(item('Apple to report earnings after the bell', 40), ['AAPL']);
  m.add(item('Supplier says Apple orders are up', 50), ['AAPL']);

  const macro = item('Fed cuts rates by 50 basis points in surprise move', 60);
  assert.deepEqual(m.related(macro, ['SPY', 'BTC-USD'], macro.recvTs), [{ minutes_ago: 30, source: 'fed', headline: 'Fed issues FOMC statement: rates lowered by 50 basis points' }]);

  const apple = item('Apple Q3 EPS beats estimates', 61);
  assert.deepEqual(
    m.related(apple, ['AAPL'], apple.recvTs + 4 * 60_000).map(e => [e.minutes_ago, e.headline]),
    [
      [15, 'Supplier says Apple orders are up'],
      [25, 'Apple to report earnings after the bell'],
    ],
    'newest first, and "minutes ago" counts from when the model reads it',
  );
});

test('earlier headlines stop at six hours and at five entries, and never include later items', () => {
  const m = new RecentNews();
  m.add(item('Apple old story', 0), ['AAPL']);
  for (let i = 1; i <= 7; i++) m.add(item(`Apple story number ${i}`, 400 + i), ['AAPL']);
  const now = item('Apple new story', 410);
  m.add(item('Apple story from the future', 420), ['AAPL']);
  const related = m.related(now, ['AAPL'], now.recvTs);
  assert.equal(related.length, 5);
  assert.ok(related.every(e => e.headline !== 'Apple old story' && e.headline !== 'Apple story from the future'));
});
