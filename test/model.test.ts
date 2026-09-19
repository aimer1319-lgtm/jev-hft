import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ask, decide, directionQuestions, DIRECTIONS, flatThresholds, isTimeout, isTransient, RateLimitedError } from '../src/model/jev.ts';
import { newsQuestions, spanWords } from '../src/news/questions.ts';
import { instrument } from '../src/news/instruments.ts';
import { scriptedModel } from './helpers.ts';

test('"flat" scales with how much the price is moving, in steps of 0.1 bp', () => {
  // Quiet market: 0.27 bp per second. Half a typical move over 2, 10 and 60 seconds.
  assert.deepEqual(flatThresholds(0.27, 0.5), { dir_2s: 0.2, dir_10s: 0.4, dir_60s: 1 });
  // Busy market: 1.5 bp per second.
  assert.deepEqual(flatThresholds(1.5, 0.5), { dir_2s: 1.1, dir_10s: 2.4, dir_60s: 5.8 });
  assert.deepEqual(flatThresholds(0.01, 0.5), { dir_2s: 0.1, dir_10s: 0.1, dir_60s: 0.1 }, 'never below 0.1 bp');
});

test('"flat" falls back to the fixed thresholds when scaling is off or volatility is unknown', () => {
  const fixed = { dir_2s: DIRECTIONS.dir_2s.flatBps, dir_10s: DIRECTIONS.dir_10s.flatBps, dir_60s: DIRECTIONS.dir_60s.flatBps };
  assert.deepEqual(flatThresholds(0.27, 0), fixed);
  assert.deepEqual(flatThresholds(NaN, 0.5), fixed);
  assert.deepEqual(flatThresholds(0, 0.5), fixed);
});

test('the direction questions state their horizon and threshold exactly', () => {
  const q = directionQuestions({ dir_2s: 0.2, dir_10s: 0.4, dir_60s: 1 });
  assert.deepEqual(Object.keys(q), ['dir_2s', 'dir_10s', 'dir_60s']);
  const ten = q.dir_10s as { instructions: string; criteria: Record<string, string> };
  assert.match(ten.instructions, /10 seconds from now/);
  assert.deepEqual(ten.criteria, { up: 'Higher by more than 0.4 basis points', down: 'Lower by more than 0.4 basis points', flat: 'Within 0.4 basis points of the current mid' });
});

test('the news questions name the span that is measured afterwards', () => {
  assert.equal(spanWords(1800), '30 minutes');
  assert.equal(spanWords(60), '1 minute');
  assert.equal(spanWords(3600), '1 hour');
  assert.equal(spanWords(90), '90 seconds');
  const q = newsQuestions([instrument('BTC-USD'), instrument('SPY')], 1800, false);
  assert.deepEqual(Object.keys(q), ['novel', 'relevant_0', 'direction_0', 'magnitude_0', 'relevant_1', 'direction_1', 'magnitude_1']);
  assert.equal(q.relevant_1!.instructions, 'Could this news plausibly move the price of the S&P 500 index (SPY ETF) within the next 30 minutes?');
  assert.notDeepEqual(q.magnitude_0!.criteria, q.magnitude_1!.criteria, 'stocks are judged on a wider scale than Bitcoin');
});

test('which failures are worth another try', () => {
  const status = (statusCode: number) => Object.assign(new Error('x'), { statusCode });
  assert.equal(isTransient(status(504)), true);
  assert.equal(isTransient(status(500)), true);
  assert.equal(isTransient(status(408)), true);
  assert.equal(isTransient(new TypeError('fetch failed')), true, 'network trouble has no status');
  assert.equal(isTransient(Object.assign(new Error('t'), { name: 'TimeoutError' })), true);
  assert.equal(isTransient(status(400)), false);
  assert.equal(isTransient(status(401)), false);
  assert.equal(isTransient(status(404)), false);
});

test('a timeout is recognized even when the gateway wraps it in its own error', () => {
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const wrapped = Object.assign(new Error('Gateway request failed: The operation was aborted due to timeout', { cause: timeout }), { name: 'GatewayInternalServerError', statusCode: 500 });
  assert.equal(isTimeout(timeout), true);
  assert.equal(isTimeout(wrapped), true);
  assert.equal(isTransient(wrapped), true);
  assert.equal(isTimeout(Object.assign(new Error('nope'), { statusCode: 500 })), false);
  assert.equal(isTimeout(undefined), false);
});

test('a call returns the answers with what the gateway reported about it', async () => {
  const { model } = scriptedModel();
  const res = await ask(model, 'state', { q: { type: 'boolean', instructions: 'x?' } });
  assert.equal(res.answers.q.probability, 0.9);
  assert.deepEqual(res.meta, { inputTokens: 600, costUsd: 0.000025, providerMs: 120, confidence: { direction_0: 0.75, magnitude_0: 0.5 } });
});

test('a rate-limit refusal is told apart from other failures, and nothing is retried', async () => {
  const limited = scriptedModel(['rate-limit']);
  await assert.rejects(ask(limited.model, 's', { q: { type: 'boolean', instructions: 'x?' } }), RateLimitedError);
  assert.equal(limited.calls.length, 1);
  const broken = scriptedModel(['server-error']);
  await assert.rejects(ask(broken.model, 's', { q: { type: 'boolean', instructions: 'x?' } }), (e: Error) => !(e instanceof RateLimitedError));
  assert.equal(broken.calls.length, 1);
});

test('a market-data decision keeps every probability', async () => {
  const { model } = scriptedModel();
  const res = await decide(model, 'state', { dir_2s: 0.2, dir_10s: 0.4, dir_60s: 1 });
  assert.deepEqual(Object.keys(res.probabilities), ['dir_2s', 'dir_10s', 'dir_60s']);
  assert.deepEqual(res.probabilities.dir_2s, { up: 0.8, down: 0.1, flat: 0.1 });
});
