import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sliceAt } from '../src/dashboard/web/charts.ts';

const T0 = 1_800_000_000_000;
const WINDOW = 15 * 60_000;

/** Which of `times` get a marker: the first in each slice of time, in the order they are drawn. */
function drawn(times: number[], span: number) {
  const sliceOf = sliceAt(span);
  const out: number[] = [];
  let last = NaN;
  for (const t of times) {
    const slice = sliceOf(t);
    if (slice === last) continue;
    last = slice;
    out.push(t);
  }
  return out;
}

test('a busy window is thinned to something a chart can draw', () => {
  const answers = Array.from({ length: 900 }, (_, i) => T0 + i * 1000); // 15 minutes, one a second
  const marked = drawn(answers, WINDOW);
  assert.ok(marked.length <= 320, `drew ${marked.length} markers`);
  assert.ok(marked.length >= 200, `drew only ${marked.length} markers, too sparse to read`);
});

test('a sparse window keeps every call', () => {
  const answers = Array.from({ length: 20 }, (_, i) => T0 + i * 30_000); // one every 30 s
  assert.equal(drawn(answers, WINDOW).length, 20);
});

test('what is drawn never changes as the window slides over it', () => {
  // The bug this guards against: choosing markers by their position in the list. The list is a
  // sliding window, so every second the oldest call leaves and every other call's position
  // shifts by one, which silently redrew most of the chart every second.
  //
  // The data has to be longer than the window, or nothing ever leaves and the window never
  // actually slides — which is how the first version of this test passed against the old bug.
  const all = Array.from({ length: 2400 }, (_, i) => T0 + i * 1000); // 40 minutes, one a second
  const startAt = T0 + WINDOW + 60_000; // far enough in that the window is full and shedding
  const at = (now: number) => drawn(all.filter(t => t > now - WINDOW && t <= now), WINDOW);
  let previous = at(startAt);
  assert.ok(all.filter(t => t > startAt - WINDOW && t <= startAt).length >= 900, 'the window must really be full');
  for (let second = 1; second <= 300; second++) {
    const now = startAt + second * 1000;
    const current = at(now);
    const stillOnScreen = previous.filter(t => t > now - WINDOW);
    assert.ok(stillOnScreen.length < previous.length, `second ${second}: nothing left the window, so it is not being tested`);
    const kept = stillOnScreen.filter(t => current.includes(t));
    assert.deepEqual(kept, stillOnScreen, `second ${second}: ${stillOnScreen.length - kept.length} of ${stillOnScreen.length} markers were dropped or swapped while still on screen`);
    previous = current;
  }
});

test('a new call never changes which earlier calls are marked', () => {
  // Before the window fills, calls only arrive; none leave. Adding one must leave the rest alone.
  const all = Array.from({ length: 600 }, (_, i) => T0 + i * 1000);
  for (let n = 300; n < 600; n++) {
    const before = drawn(all.slice(0, n), WINDOW);
    const after = drawn(all.slice(0, n + 1), WINDOW);
    assert.deepEqual(after.slice(0, before.length), before, `adding call ${n} changed which earlier ones were marked`);
  }
});

test('the slice is a round number of seconds, and never shorter than one', () => {
  const sliceOf = sliceAt(WINDOW);
  // 15 minutes over 260 markers is about 3.5 s, rounded to 3 s.
  assert.equal(sliceOf(T0 + 3000) - sliceOf(T0), 1);
  assert.equal(sliceOf(T0 + 2999) - sliceOf(T0), 0);
  // A very short window must not ask for a slice of zero, which would divide by nothing.
  const tiny = sliceAt(1000);
  assert.equal(tiny(T0 + 1000) - tiny(T0), 1);
  assert.ok(Number.isFinite(tiny(T0)));
});
