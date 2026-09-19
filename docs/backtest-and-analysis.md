# Recording, replaying, and judging the results

Code: `src/record.ts`, `src/backtest.ts`, `src/analyze.ts`, `src/analyze-news.ts`,
`src/lib/stats.ts`.

## Why test on recorded data first

Two different questions need answering:

1. **Does Jev see anything useful at all?** This doesn't depend on speed, and it takes thousands
   of decisions to answer.
2. **Can we act on it before the market moves?** This depends entirely on speed.

Testing the first question live is slow: at best a few decisions a second, and about one a
minute on the free gateway tier. So the plan is: record market data, replay it and ask Jev
about many past moments at once, and only work on speed if there's something worth capturing.

## Recording (`npm run record`)

Saves every standard market event from Coinbase into a compressed file under `data/raw/`. It
saves the tidied-up events rather than Coinbase's raw messages, so replays don't need any
Coinbase-specific code. Three minutes came to about 4,000 events and 552 KB, which works out to
roughly 11 MB an hour.

## Replaying (`npm run backtest -- <file>`)

1. Feeds the recording through the same market-state code the live run uses.
2. Every `STEP_S` seconds (default 5), after a warm-up, takes a snapshot and writes Jev's text.
   Each snapshot is taken *before* applying the next event, so it only knows what was known at
   that moment. **That ordering is what keeps the backtest honest; don't change it.**
3. Asks Jev about the snapshots, several at a time (`BT_CONCURRENCY`). If refused for too many
   requests, it waits and tries again instead of skipping, because completeness matters more
   than speed here.
4. Pretends each answer arrived `BT_LATENCY_MS` later (default 375 ms) and looks up the prices
   from that moment.
5. Writes the results in the same format as live runs, so the same report reads both.

The pretend delay is fixed, while real delays vary (a slow case is about 550 ms). Try a
pessimistic `BT_LATENCY_MS` to see how much it matters.

## The market-data report (`npm run analyze -- <files>`)

It prints four sections.

**1. Where the time went:** how old the data was, how long the text took, how long Jev took, and
the total. Each is shown as typical (median), slow (90th percentile), and very slow (99th).

**2. The "perfect foresight" line:** for each horizon, the average size of the price move. No
prediction can earn more per trade than this, so compare it with your trading cost (`FEE_BPS`)
before anything else. In our recorded data it was 0.05 bp at 1 second and 0.95 bp at 60
seconds, against a cost of about 10 bp. That's why this path can't be profitable at these
horizons, however good the predictions.

**3. How good each signal was,** for Jev and for the four simple rules, at each horizon:

| Column | Plain meaning |
|---|---|
| `IC` | how well the signal ranked what happened, from −1 to +1 (0 means no relationship) |
| `t` | how confident we can be that the IC isn't luck; roughly, above 2 starts to mean something |
| `hit%` | how often the signal pointed the right way |
| `Q5-Q1bp` | how much better the strongest "up" calls did than the strongest "down" calls |
| `net edge bp` | what trading on the strongest calls would have earned per trade, after costs |

Jev is scored from when its answer arrived (what you could actually trade). It's also shown
"@state", scored from the snapshot, to see whether it saw something real even if too late to
use. The simple rules are scored from the snapshot, since they take no time to compute.

The confidence number (`t`) counts only truly separate stretches of time. Decisions a fraction of
a second apart look at nearly the same future, so counting each one separately would make
results look far more certain than they are.

**4. Late arrival and calibration:** how much the price moved while Jev was thinking, and whether
Jev's probabilities match reality (when it says 70%, does it happen about 70% of the time?).

## The news report (`npm run analyze:news -- <files>`)

Bitcoin and stocks are reported separately.

1. **How fast news reached us,** per source, and how long items waited for Jev.
2. **Does Jev know which news matters?** The average price move after items Jev called relevant,
   compared with items it didn't, and whether its "how big" answers lined up with the actual size
   of moves. This is checked first because it takes far fewer examples to show than direction.
3. **Does Jev know the direction?** For relevant items, did prices move the way it said?
4. **How much was already gone** before we could act: moves between publication and when we got
   the item, and while Jev was thinking.
5. **The items themselves,** most relevant first.

Stock records whose spread was too wide (`MAX_SPREAD_BPS`, default 50 bp) are left out of price
measurements, because the midpoint of prices that far apart isn't a real price. Read stock
results by trading session: a move measured while the market is closed isn't a move you could
trade. Older records made before stocks were added are treated as Bitcoin.

News arrives slowly, a few items an hour from most sources, so treat the numbers as anecdotes
until there are hundreds of relevant items.

## The math helpers (`lib/stats.ts`)

Percentiles, averages, and rank correlation, plus two safety helpers every report uses: `num()`
turns anything that isn't a number into "unknown", and `bps()` measures a price change, giving
"unknown" if either price is missing. They exist because of a real bug: unknown prices are saved
as `null`, and `null` quietly acts like zero in math, which once turned every unfinished horizon
into a fake −10,000 bp crash.

## How we checked the reports themselves

- With the random mock model, Jev's scores came out at about zero, as they should. That shows the
  reports aren't accidentally peeking at future prices.
- The simple rules showed small positive scores at 1 to 5 seconds, which is what's normally seen
  for these rules (the samples were too short to be conclusive).
- Unfinished horizons show as `-`, never as zero.
