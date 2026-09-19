# The order book, market measurements, and what Jev reads

Code: `src/market/`. Most of this is the market-data path's view of Bitcoin; the last sections
cover the pieces the news path uses to price Bitcoin and stocks alike.

## The order book (`book.ts`)

The order book is every buy and sell offer waiting on Coinbase, grouped by price. Ours holds all
of it, about 40,000 price levels, and applies each change as it arrives.

**Why keep the whole book?** Prices far from today's price become the front of the line when the
market moves. A partial book would have to be refetched constantly.

**Why it's stored the way it is:** almost all changes happen near the best bid and ask. The prices
are kept in sorted lists with the best price at the *end*, where adding or removing an entry is
quick. With the best price at the start, every change meant shifting about 20,000 entries. The
switch made handling an update about six times faster (from 0.135 ms to 0.021 ms typical). The
opening snapshot is loaded all at once and sorted once, which cut a reconnect's pause from 66 ms
to 7.6 ms.

**How we know it's right:** after 30 seconds of live updates, we compared our book with a fresh
snapshot. The best bid and ask matched exactly, almost every level near the price matched (the
few differences were levels changing between the two snapshots), and the bid never reached the
ask. The book's basic behaviour is also covered by tests ([testing.md](testing.md)).

## The market state (`state.ts`)

`MarketState` is everything the pipeline knows about Bitcoin right now:

- the order book
- the last 30 seconds of trades
- the price history (every change in the mid price), used to measure past moves and to look up
  the price at any recent moment
- one reading per second of a few measurements from the last 10 minutes, used to tell whether
  the current values are unusual

It only changes when a new market event arrives, and never reads the clock itself.
**Why:** so replaying recorded data gives exactly the same results as the live run
([architecture.md](architecture.md#2-market-state-only-changes-when-data-arrives)).

How much price history it keeps depends on who's using it: 5 minutes for the live market-data
path, 65 minutes for the news path (30 minutes of context plus 30 minutes of checks afterwards),
and everything for backtests.

### While the feed is broken, the price is unknown

When the feed reports that data may have been lost, the state notes when it last heard anything
good. From that moment until the next full snapshot arrives, asking "what was the price at time
t?" gives "unknown" rather than the last price from before the break.

**Why:** the old behaviour quietly reported "the price didn't move" for however long the outage
lasted. A decision whose 10-second check landed inside an outage was recorded as a move of zero,
which is a made-up number. "Unknown" is left out of every statistic instead
([architecture.md](architecture.md#5-missing-is-not-zero)). After a break the once-a-second
volatility readings also start over, so a "one-second" price change can never stretch across the
gap.

### What it measures

| Measurement | Meaning | Why it's included |
|---|---|---|
| Bid, ask, spread | the best prices and the gap between them | context; the spread is part of the cost of trading |
| Book imbalance at 1, 5, and 20 levels | are there more buyers or sellers waiting near the price? | the classic short-term predictor |
| Depth within 0.1% | how much is waiting close to the price | how easily a move could be absorbed |
| Price change over 1, 5, 30, 60 seconds | recent momentum | trends and reversals |
| Volatility | how much the price has been jumping, second to second | tells Jev what counts as a big number right now, and sets what "flat" means in its questions ([model.md](model.md#the-market-data-questions)) |
| Order flow over 1, 5, 30 seconds | buying that made trades happen minus selling that did | aggressive buying or selling moves prices |
| Trades in the last 5 seconds | count, buys versus sells, largest trade | activity level and big trades |

For some of these, the state also works out how unusual today's value is compared with the last
10 minutes (a "z-score": 0 means ordinary, +2 or −2 means unusually high or low). **Why:** Jev
has no idea whether 0.3 Bitcoin of buying in 5 seconds is a lot; "unusually high" tells it
directly, and adjusts automatically as the market gets busier or quieter.

One measurement, the "microprice", is calculated but not shown to Jev. For Bitcoin on Coinbase
the gap between bid and ask is almost always the smallest possible, and then the microprice says
nothing that book imbalance doesn't already say.

## What Jev reads (`encode.ts`)

The measurements are turned into a few labeled lines:

```
BTC-USD 05:56 UTC mid 81028.51 (bid 81028.50 / ask 81028.51, spread 0.001bp)
mid returns: 1s +0.00bp, 5s +0.00bp (z +0.0), 30s -0.24bp, 60s -1.55bp; 1s volatility 0.27bp (z +0.6)
taker flow, buy minus sell (BTC): 1s -0.000, 5s +0.001 (z -0.0), 30s +0.001
last 5s: 23 trades (z -0.3) (11 buy / 12 sell), largest 0.0007 buy
book imbalance (bid-ask)/(bid+ask): L1 +0.70 (z +0.6), L5 +0.46 (z +0.5), L20 -0.52
depth within 10bp: bid 26.29, ask 24.68
```

- **Labels and units on every number,** because Jev reads language, not spreadsheets.
- **Summaries instead of raw price levels.** Sending Jev a much longer text didn't make it any
  slower, but it cost up to 15 times more, and a few summarized numbers say more than a hundred
  raw ones.
- **Time to the minute only.** A timestamp down to the millisecond would make every text
  different from the last without adding anything useful.
- **"n/a" when something isn't known yet** (like the 60-second change right after startup),
  rather than a zero that would falsely say "nothing moved".

A plain JSON version exists too (`JEV_ENCODING=json`) for comparison; it's about the same length.

## Replaying recorded data (`replay.ts`)

A backtest feeds a recording through the market state and takes a snapshot every few seconds.
`replayer()` is the small function that does this, and it guarantees one thing: **a snapshot for
time *t* is taken before the first event received at or after *t* is applied.** So a snapshot can
only ever know what was known at its own moment. Doing those two steps in the other order would
let every snapshot peek a few milliseconds into its own future, and results would look slightly
better than they are. A test checks this directly.

## Prices for the news path (`quotes.ts`, `prices.ts`, `sessions.ts`)

The news path needs to ask "what did this cost at time *t*?" about Bitcoin and about any US stock,
and shouldn't care where the answer comes from.

- **`prices.ts`** is that one question, answered from the Coinbase order book for Bitcoin and from
  Alpaca's quotes for stocks. It also answers "how far apart were the bid and ask?" and "what was
  the last closing price?".
- **`quotes.ts`** keeps each stock's price history. Each entry holds the midpoint *and the spread*
  at that moment. **Why the spread too:** outside trading hours a stock's bid and ask can be
  several percent apart, and the midpoint of that is not a price anyone could trade at. Keeping
  the spread over time lets the report check that there was a real price both when a decision was
  made *and* at each later check ([news.md](news.md#prices)).
- **`sessions.ts`** knows US market hours in New York time, including daylight saving: `pre`
  (4:00 to 9:30), `regular` (9:30 to 16:00), `post` (16:00 to 20:00), and `closed`. Holidays and
  early closes aren't listed; on those days quotes are missing or very wide, which the spread
  checks catch.

## Adding a measurement

1. Add it to `Features` and calculate it in `MarketState.features()` (no clock reads).
2. If knowing "how unusual is this" helps, add it to `NORMALIZED`.
3. Add a labeled line with units in `encode.ts`.
4. If it's a simple rule Jev should beat, add it to the baselines in `engine.ts` and `analyze.ts`.
5. Add a test for it next to the existing ones in `test/state.test.ts`.
