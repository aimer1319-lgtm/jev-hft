# Tests

Code: `test/`. Run them with `npm test`. `npm run check` runs the type check and the tests
together; do that before committing. GitHub runs the same check on every push
(`.github/workflows/check.yml`).

## Why this project has tests

Everything this project concludes rests on measuring correctly: which price was known when, which
moves count, how much evidence there really is. Those rules are easy to break without noticing,
because a broken measurement still produces plausible-looking numbers. The tests pin the rules
down so a future change that breaks one fails loudly instead.

They use Node's built-in test runner, so there's nothing extra to install. They need no network,
no keys, and no waiting, and the whole set runs in about a second.

## What's covered

| File | What it protects |
|---|---|
| `book.test.ts` | the order book: best prices, inserting and removing levels, size near the price |
| `state.test.ts` | "the price at time t" never uses a later price; **the price is unknown during a feed outage**; order flow is signed and windowed correctly; **a replayed snapshot knows nothing from its own future** |
| `quotes.test.ts` | stock price history: spreads kept over time, bad quotes ignored, older prices only fill in the past, prices unknown while the connection is down |
| `stats.test.ts` | percentiles and rank correlation; **missing is never treated as zero**; bursts of decisions count as one piece of evidence |
| `instruments.test.ts` | which assets an item is about; `$ETH` isn't mistaken for a stock; how assets are named to Jev; **US market hours across daylight saving and weekends** |
| `sources.test.ts` | reading RSS, Atom, and RDF feeds; SEC filing entries; the company list; X searches and posts |
| `memory.test.ts` | what counts as a repeat headline, and which earlier headlines Jev is shown |
| `model.test.ts` | how "flat" scales with volatility; the exact wording of questions; which failures are worth retrying; timeouts hidden inside the gateway's own errors |
| `news-engine.test.ts` | (also: the dashboard is told what became of every headline, and why) the news loop end to end: one call per item, **no call when the outcome can't be measured**, repeats skipped, rate limits waited out, failures retried at most three times, records completed correctly |
| `live-engine.test.ts` | the market-data loop: warm-up, spacing, pausing after a refusal, starting over after a feed break |
| `lib.test.ts` | pause lengths after refusals, feed back-off, the "already seen" memory |
| `recorder.test.ts` | a saved recording holds every event and is readable once closed |
| `telemetry.test.ts` | messages for the dashboard leave together and later, never while the pipeline's own code is running; **a dashboard that's off, missing, or sent something unsendable is never the pipeline's problem** |
| `collector.test.ts` | what the dashboard makes of each message: a question, its answer and its outcome end up together; restarts of the pipeline don't mix decisions up; history is bounded; headlines restored from disk slot in correctly |
| `outcomes.test.ts` | the dashboard's scoreboard: only decisions where the price moved are judged, unknown stays unknown, and a Jev that merely repeats a rule scores nothing beyond it |

## How the engines are tested without the outside world

`test/helpers.ts` has three stand-ins:

- **A scripted model.** It answers the same way every time, after first playing out a list you
  give it: `['rate-limit', 'ok']` means "refuse the first call, answer the second". That makes it
  possible to test what happens on the third failure in a row, which you can't arrange with a
  real service. It also returns the extra details the real gateway returns (cost, TypeSafe's time,
  confidence), so recording them is tested too.
- **Fake prices.** Whatever the test says they are, optionally drifting over time so that "the
  price 10 seconds later" is a different, checkable number.
- **A clock the test controls.** The news engine takes its clock as a setting, so a test can say
  "it's Wednesday noon in New York" or "five minutes have passed" without waiting, and tests
  about market hours pass on a Saturday.

## The one check tests can't replace

Tests show each rule holds in isolation. They don't show the whole pipeline is free of peeking at
the future. For that, run the practice model through a real recording and check it scores about
zero ([backtest-and-analysis.md](backtest-and-analysis.md#how-we-checked-the-reports-themselves)).

## Adding tests

Put the file in `test/` with a name ending in `.test.ts`. Name each test after the rule it
protects, in plain words ("while the feed is broken the price is unknown, not unchanged"), so a
failure explains itself.
