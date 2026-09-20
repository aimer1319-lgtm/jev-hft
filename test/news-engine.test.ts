import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NewsEngine, type NewsRecord } from '../src/news/engine.ts';
import type { NewsItem } from '../src/news/types.ts';
import type { TelemetryBody } from '../src/telemetry/events.ts';
import { FakePrices, scriptedModel, settle, type Step } from './helpers.ts';

const WEDNESDAY_NOON_NY = Date.parse('2026-07-15T16:00:00Z'); // regular session
const SATURDAY = Date.parse('2026-07-18T16:00:00Z');

function setup(script: Step[] = [], opts: { start?: number; onlyTradable?: boolean } = {}) {
  let now = opts.start ?? WEDNESDAY_NOON_NY;
  const prices = new FakePrices().set('BTC-USD', { mid: 80_000, spreadBps: 0.001 }).set('AAPL', { mid: 200, spreadBps: 3, lastClose: 198 });
  prices.t0 = now;
  const { model, calls } = scriptedModel(script);
  const written: NewsRecord[] = [];
  const logs: string[] = [];
  const told: TelemetryBody[] = []; // what the dashboard would be told
  const engine = new NewsEngine(prices, {
    model,
    provider: 'test',
    horizonsS: [10, 60],
    maxAgeMs: 300_000,
    maxInFlight: 2,
    maxSymbolsPerItem: 3,
    untagged: ['SPY', 'BTC-USD'],
    timeoutMs: 60_000,
    onlyTradable: opts.onlyTradable ?? true,
    maxSpreadBps: 50,
    companyName: t => (t === 'AAPL' ? 'Apple Inc.' : undefined),
    now: () => now,
    emit: e => told.push(e),
    write: r => written.push(r),
    log: s => logs.push(s),
  });
  let n = 0;
  const item = (headline: string, symbols?: string[]): NewsItem => ({ id: `t:${++n}`, source: 'test', sourceLabel: 'newswire', headline, publishedTs: now - 5000, recvTs: now, ...(symbols ? { symbols } : {}) });
  return { engine, prices, calls, written, logs, told, item, advance: (ms: number) => (now += ms), now: () => now };
}

test('an item becomes one call and one complete record per instrument, written once its last horizon has passed', async () => {
  const s = setup();
  s.prices.driftPerMs = 0.001; // +$1 per second, so forward prices are distinguishable
  s.engine.onItem(s.item('Apple raises guidance', ['AAPL', 'BTC-USD']));
  await settle();
  assert.equal(s.calls.length, 1, 'both instruments share one call');
  assert.deepEqual(Object.keys(s.calls[0]!.questions), ['novel', 'relevant_0', 'direction_0', 'magnitude_0', 'relevant_1', 'direction_1', 'magnitude_1']);
  assert.match(s.calls[0]!.questions.relevant_0!.instructions, /Apple Inc\. \(AAPL\) within the next 1 minute/, 'the question names the company and the span we measure');

  s.engine.tick(s.now() + 59_000);
  assert.equal(s.written.length, 0, 'not before the longest horizon');
  s.advance(61_000);
  s.engine.tick(s.now());
  assert.equal(s.written.length, 2);
  const [aapl, btc] = s.written as [NewsRecord, NewsRecord];
  assert.equal(aapl.v, 2);
  assert.equal(aapl.symbol, 'AAPL');
  assert.equal(aapl.session, 'regular');
  assert.equal(aapl.instruments, 2);
  assert.equal(aapl.relevant, 0.9);
  assert.ok(Math.abs(aapl.signal - 0.9 * 0.7) < 1e-12);
  assert.deepEqual(aapl.confidence, { direction: 0.75, magnitude: 0.5 });
  assert.equal(aapl.costUsd, 0.000025);
  assert.equal(aapl.providerMs, 120);
  assert.equal(aapl.inputTokens, 600);
  assert.equal(aapl.attempts, 1);
  assert.equal(aapl.fwdResp[10], 200 + 10, 'the price 10 s after the answer');
  assert.equal(aapl.fwdResp[60], 200 + 60);
  assert.deepEqual(aapl.fwdSpreadBps, { 10: 3, 60: 3 }, 'stocks also record whether the exit quote was usable');
  assert.equal(btc.symbol, 'BTC-USD');
  assert.equal(btc.session, '24/7');
  assert.equal(btc.fwdSpreadBps, undefined);
  assert.match(String(aapl.state.markets.AAPL), /Apple Inc\. \(AAPL\) 200\.00 \(quote spread 3bp\), US session regular; change since last close \+1\.01%/);
});

test('stopping early writes what is known and leaves the rest unknown', async () => {
  const s = setup();
  s.engine.onItem(s.item('Bitcoin ETF approved', ['BTC-USD']));
  await settle();
  s.advance(15_000);
  s.engine.flush(s.now(), true);
  assert.equal(s.written.length, 1);
  assert.equal(s.written[0]!.fwdResp[10], 80_000);
  assert.ok(Number.isNaN(s.written[0]!.fwdResp[60]), 'that moment had not happened yet');
});

test('no call is made when the outcome could not be measured', async () => {
  const closed = setup([], { start: SATURDAY });
  closed.engine.onItem(closed.item('Apple raises guidance', ['AAPL']));
  await settle();
  assert.equal(closed.calls.length, 0);
  assert.equal(closed.engine.stats.closed, 1);
  assert.equal(closed.prices.prepared.length, 0, 'a closed market is not even subscribed to');

  const wide = setup();
  wide.prices.set('AAPL', { mid: 200, spreadBps: 400 });
  wide.engine.onItem(wide.item('Apple raises guidance', ['AAPL']));
  await settle();
  assert.equal(wide.calls.length, 0);
  assert.equal(wide.engine.stats.unpriced, 1);
  assert.match(wide.logs.join('\n'), /AAPL quote is 400bp wide/);

  const overLimit = setup();
  overLimit.prices.set('AAPL', { mid: 200, spreadBps: 3, tracked: false });
  overLimit.engine.onItem(overLimit.item('Apple raises guidance', ['AAPL']));
  await settle();
  assert.equal(overLimit.calls.length, 0);
  assert.equal(overLimit.engine.stats.unpriced, 1);

  const unpriceable = setup();
  unpriceable.engine.onItem(unpriceable.item('Ether news', []));
  await settle();
  assert.equal(unpriceable.engine.stats.unpriceable, 1);
});

test('an item about several instruments is asked about only those that can be measured', async () => {
  const s = setup();
  s.prices.set('AAPL', { mid: 200, spreadBps: 400 });
  s.engine.onItem(s.item('Apple to hold Bitcoin', ['AAPL', 'BTC-USD']));
  await settle();
  assert.equal(s.calls.length, 1);
  assert.deepEqual(Object.keys(s.calls[0]!.questions), ['novel', 'relevant_0', 'direction_0', 'magnitude_0']);
  assert.match(s.calls[0]!.questions.relevant_0!.instructions, /Bitcoin/);
});

test('with the filter off, everything routed is asked about', async () => {
  const s = setup([], { start: SATURDAY, onlyTradable: false });
  s.engine.onItem(s.item('Apple raises guidance', ['AAPL']));
  await settle();
  assert.equal(s.calls.length, 1);
});

test('a repeat of a recent headline is skipped; a different story is asked about and shown what came before', async () => {
  const s = setup();
  s.engine.onItem(s.item('Fed cuts interest rates by 50 basis points', ['BTC-USD']));
  await settle();
  s.advance(60_000);
  s.engine.onItem(s.item('Fed cuts interest rates by 50 basis points!', ['BTC-USD']));
  await settle();
  assert.equal(s.calls.length, 1);
  assert.equal(s.engine.stats.duplicates, 1);

  s.advance(60_000);
  s.engine.onItem(s.item('Bitcoin jumps after Fed cuts rates by 50 basis points', ['BTC-USD']));
  await settle();
  assert.equal(s.calls.length, 2);
  const state = s.calls[1]!.state as { earlier_related_headlines?: { minutes_ago: number; headline: string }[] };
  assert.deepEqual(state.earlier_related_headlines, [{ minutes_ago: 2, source: 'newswire', headline: 'Fed cuts interest rates by 50 basis points' }]);
  assert.match(s.calls[1]!.questions.novel!.instructions, /earlier_related_headlines is already known/);
  assert.doesNotMatch(s.calls[0]!.questions.novel!.instructions, /earlier_related_headlines/);
});

test('a story we never got an answer about is not allowed to hide a later report of it', async () => {
  const s = setup();
  s.prices.set('AAPL', { mid: 200, spreadBps: 400 }); // 9:29 am: the quote is still too wide
  s.engine.onItem(s.item('Apple raises full-year guidance', ['AAPL']));
  await settle();
  assert.equal(s.engine.stats.unpriced, 1);
  s.prices.set('AAPL', { mid: 200, spreadBps: 3 }); // two minutes later the market is open
  s.advance(120_000);
  s.engine.onItem(s.item('Apple raises full-year guidance', ['AAPL']));
  await settle();
  assert.equal(s.engine.stats.duplicates, 0);
  assert.equal(s.calls.length, 1);
  const state = s.calls[0]!.state as { earlier_related_headlines?: unknown[] };
  assert.equal(state.earlier_related_headlines?.length, 1, 'the first report is still shown as already known');
});

test('a rate-limited item waits its turn and is asked again; the wait is recorded', async () => {
  const s = setup(['rate-limit']);
  s.engine.onItem(s.item('Bitcoin ETF approved', ['BTC-USD']));
  await settle();
  assert.equal(s.engine.stats.rateLimited, 1);
  assert.equal(s.engine.queued, 1);
  s.advance(1000);
  s.engine.tick(s.now());
  await settle();
  assert.equal(s.calls.length, 1, 'still pausing');
  s.advance(5000);
  s.engine.tick(s.now());
  await settle();
  assert.equal(s.calls.length, 2);
  assert.equal(s.engine.stats.decisions, 1);
  s.engine.flush(s.now(), true);
  assert.equal(s.written[0]!.queueMs, 6000);
  assert.equal(s.written[0]!.attempts, 1, 'a refusal is not an attempt');
});

test('a passing failure is retried a little later, at most three calls in all', async () => {
  const s = setup(['server-error', 'server-error', 'server-error']);
  s.engine.onItem(s.item('Bitcoin ETF approved', ['BTC-USD']));
  await settle();
  assert.equal(s.calls.length, 1);
  assert.equal(s.engine.queued, 1);
  s.engine.tick(s.now());
  await settle();
  assert.equal(s.calls.length, 1, 'not retried at once');
  for (let i = 0; i < 4; i++) {
    s.advance(10_000);
    s.engine.tick(s.now());
    await settle();
  }
  assert.equal(s.calls.length, 3);
  assert.deepEqual([s.engine.stats.retries, s.engine.stats.errors, s.engine.queued], [2, 1, 0]);

  const recovered = setup(['server-error']);
  recovered.engine.onItem(recovered.item('Bitcoin ETF approved', ['BTC-USD']));
  await settle();
  recovered.advance(3000);
  recovered.engine.tick(recovered.now());
  await settle();
  assert.equal(recovered.engine.stats.decisions, 1);
  recovered.engine.flush(recovered.now(), true);
  assert.equal(recovered.written[0]!.attempts, 2);
});

test('a request the server rejects outright is not retried', async () => {
  const s = setup(['bad-request']);
  s.engine.onItem(s.item('Bitcoin ETF approved', ['BTC-USD']));
  await settle();
  s.advance(60_000);
  s.engine.tick(s.now());
  await settle();
  assert.equal(s.calls.length, 1);
  assert.equal(s.engine.stats.errors, 1);
});

test('an item that waited too long for the model is dropped, and counted', async () => {
  const s = setup(['rate-limit']);
  s.engine.onItem(s.item('Bitcoin ETF approved', ['BTC-USD']));
  await settle();
  s.advance(301_000);
  s.engine.tick(s.now());
  await settle();
  assert.equal(s.calls.length, 1);
  assert.equal(s.engine.stats.dropped, 1);
});

test('the dashboard is told what became of every headline, and why', async () => {
  const s = setup(['server-error']);
  s.prices.set('MSFT', { mid: 400, spreadBps: 900 });
  s.engine.onItem(s.item('Bitcoin ETF approved', ['BTC-USD'])); // fails once, then answered
  s.engine.onItem(s.item('Bitcoin ETF approved!', ['BTC-USD'])); // a repeat
  s.engine.onItem(s.item('Ether upgrade', [])); // nothing we can price
  s.engine.onItem(s.item('Microsoft wins contract', ['MSFT'])); // quote too wide
  await settle();
  s.advance(3000);
  s.engine.tick(s.now());
  await settle();

  const about = (id: string) => s.told.filter(e => 'id' in e && e.id === id).map(e => (e.type === 'news-skip' ? `skip:${e.reason}` : e.type));
  assert.deepEqual(about('t:1'), ['news-retry', 'news-answer']);
  assert.deepEqual(about('t:2'), ['skip:repeat']);
  assert.deepEqual(about('t:3'), ['skip:unpriceable']);
  assert.deepEqual(about('t:4'), ['skip:unpriced']);

  const answer = s.told.find(e => e.type === 'news-answer')!;
  assert.ok(answer.type === 'news-answer');
  assert.equal(answer.attempts, 2);
  assert.deepEqual(answer.verdicts.map(v => [v.symbol, v.name, v.relevant]), [['BTC-USD', 'Bitcoin', 0.9]]);
  assert.equal((answer.state as { headline: string }).headline, 'Bitcoin ETF approved', 'exactly what Jev was shown');
  const skip = s.told.find(e => e.type === 'news-skip' && e.reason === 'unpriced')!;
  assert.match((skip as { detail: string }).detail, /MSFT quote is 900bp wide/);
});

test('a closed market, a lost item and a dropped one are reported too', async () => {
  const closed = setup([], { start: SATURDAY });
  closed.engine.onItem(closed.item('Apple raises guidance', ['AAPL']));
  await settle();
  assert.deepEqual(closed.told.map(e => e.type === 'news-skip' && e.reason), ['closed']);

  const lost = setup(['bad-request']);
  lost.engine.onItem(lost.item('Bitcoin ETF approved', ['BTC-USD']));
  await settle();
  assert.deepEqual(lost.told.map(e => e.type === 'news-skip' && e.reason), ['lost']);

  const dropped = setup(['rate-limit']);
  dropped.engine.onItem(dropped.item('Bitcoin ETF approved', ['BTC-USD']));
  await settle();
  dropped.advance(301_000);
  dropped.engine.tick(dropped.now());
  await settle();
  assert.deepEqual(dropped.told.map(e => (e.type === 'news-skip' ? e.reason : e.type)), ['news-retry', 'dropped']);
});
