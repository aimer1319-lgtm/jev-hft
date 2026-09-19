# How it all fits together

This page gives the big picture: the moving parts, how data flows between them, and a handful
of rules that the whole codebase follows. Most bugs in systems like this come from breaking
one of these rules, so they're worth understanding before changing anything.

## The two paths

```
MARKET-DATA PATH (Bitcoin, seconds ahead)

  Coinbase ──► feed ──► market state ──► measurements ──► short text ──► Jev ──► decision record ──► report
  (live orders   (tidy     (order book,     (imbalance,       ("mid 81012,    (up/down/   (what Jev said,     (analyze)
   and trades)   up data)   recent trades)   momentum...)       buyers ...")     flat?)      what price did)


NEWS PATH (Bitcoin and US stocks, minutes ahead)

  news feeds ─┐
  Benzinga ───┤                                                           prices from Coinbase (Bitcoin)
  SEC filings ├──► news item ──► which assets? ──► headline + context ──► Jev ──► one record per asset ──► report
  X accounts ─┤                  (tags, tickers)   (what the market          (relevant?    ▲             (analyze:news)
  typed input ┘                                     was doing)                direction?    │
                                                                              how big?)     prices from Alpaca (stocks)
```

A third workflow reuses the market-data path offline: `record` saves the Coinbase data to a
file, and `backtest` replays that file through exactly the same code to ask Jev about past
moments, many at once. Its results use the same record format as live runs, so the same report
reads both.

## The building blocks

Each block has one job and a clear "contract": what it takes in and what it promises to give
out. As long as a block keeps its contract, the rest of the system doesn't care how it works
inside. For example, a new news source only has to produce news items in the standard format;
nothing downstream changes.

| Block | Where | Takes in | Gives out | Promise |
|---|---|---|---|---|
| Feed | `src/feed/` | a service's own message format | standard market events | hides each service's quirks; says "reset" whenever data may have been lost; stamps the time each message arrived |
| Market state | `src/market/state.ts` | market events | current measurements, price at any recent moment | changes only when an event arrives; never looks at the clock itself |
| Encoder | `src/market/encode.ts` | measurements | the short text Jev reads | same input always gives the same text |
| Model access | `src/model/jev.ts` | text + questions | typed answers | one attempt only, no automatic retries; reports "too many requests" distinctly |
| Engines | `src/engine.ts`, `src/news/engine.ts` | events or news items | records | decide when to ask Jev, handle rate limits, wait for the later prices, write records |
| Runners | `src/live.ts`, `src/news-live.ts`, ... | settings | files and logs | connect the blocks, start and stop cleanly |
| Reports | `src/analyze.ts`, `src/analyze-news.ts` | record files | printed reports | read-only; never assume a value is present |

## Five rules that hold everything together

### 1. One clock: when *we* received something

Every piece of data gets stamped with the moment it arrived on our machine. All timing
(windows like "the last 5 seconds", "the price 30 minutes later") uses these arrival times.

**Why:** exchanges and news services stamp their own times, but those come from other
computers and mean different things. On Coinbase, the time a trade happened and the time the
message was sent differ by 50 to 85 milliseconds. What decides whether we could have acted on
something is when *we* knew it, so that's the clock that matters. The outside timestamps are
kept, but only to measure delays.

**In the code:** arrival times come from `nowMs()` in `src/feed/types.ts`. Code under
`src/market/` never reads the clock itself; time is always passed in.

### 2. Market state only changes when data arrives

The market state (`MarketState`) changes in exactly one way: when a new market event is
applied to it. Even once-a-second bookkeeping happens when an event's timestamp crosses into a
new second, not on a timer.

**Why:** it makes replays exact. Feed the same recorded events in, and you get exactly the
same measurements the live run saw. Timers would fire at slightly different moments during a
replay and quietly change the results.

### 3. Every decision is judged twice

For each decision we record the price at later points measured from two starting moments:

- from **when the market snapshot was taken** (`tState`): "did Jev see something real?"
- from **when Jev's answer arrived** (`tResp`): "could anyone actually have traded on it?"

Mixing these up is the most common way a slow strategy looks profitable on paper: it
"predicts" a move that finished while it was still thinking. Simple rules that take
microseconds are judged from the snapshot; Jev, which takes about a third of a second, is
judged from when its answer arrived.

### 4. Records are written once, complete

A decision isn't written to disk until its longest horizon has passed (60 seconds for the
market-data path, 30 minutes for news). Then it's written once, with every later price filled
in, so reports never have to piece partial records together.

If you stop a run normally (Ctrl-C, the system shutting it down, or `RUN_MINUTES` running out),
unfinished records are still written, with "unknown" in place of prices that hadn't happened
yet. The trade-off: if the program *crashes*, unfinished records are lost. News items
themselves are saved the moment they arrive, so the raw news survives either way.

### 5. Missing is not zero

Files store "unknown" as `null` (JSON has no way to write "not a number"). In JavaScript math,
`null` quietly acts like `0`. An early version of the report turned every unknown future price
into a fake crash of −10,000 bp this way. Now every report reads numbers through `num()` and
`bps()` in `src/lib/stats.ts`, which turn anything missing into "unknown", and every statistic
skips unknowns.

## How it runs

Each runner is a single Node.js program. Incoming data is processed as it arrives; calls to Jev
happen in the background while more data keeps flowing in. There are no extra threads or
internal queues.

That's deliberate. Handling one market update takes about 20 to 50 millionths of a second, and
preparing Jev's text takes under a thousandth of a second. A Jev answer takes about 350
thousandths. Rewriting the local code in a faster language would speed up the part that's
already about 0.1% of the total, at a large cost in complexity.

The market-data path and the news path run as separate programs (`npm run live` and
`npm run news`), so each can be started, stopped, and kept within its own limits independently.
The news program opens two connections to Alpaca (news and stock prices). Alpaca's free plan
limits how many connections one account can have, so run only one copy of the news program at
a time.

## Files on disk

```
data/
  raw/BTC-USD-<time>.jsonl.gz              Coinbase data saved by `record`
  decisions/live-<provider>-<time>.jsonl     market-data decisions from `live`
  decisions/backtest-<provider>-<time>.jsonl market-data decisions from `backtest`
  decisions/news-<provider>-<time>.jsonl     news decisions from `news`
  news/items-<time>.jsonl                   every news item received, saved immediately
  test/                                     outputs from test runs with typed headlines, kept apart
```

Every file is **JSON Lines**: one record per line. That format can be appended to as things
happen, survives a crash up to the last complete line, and loads easily into other tools (for
example `pandas.read_json(path, lines=True)` in Python). Saved market data is compressed
because there's a lot of it (about 11 MB per hour for Bitcoin); decision files aren't, so you
can open and read them. The whole `data/` folder is excluded from git.

API keys live in a `.env` file in the project folder. It's excluded from git and readable only
by you, and every npm script loads it automatically
([decisions.md](decisions.md#d29-secrets-live-in-a-gitignored-env-loaded-by-node)).

The exact fields of each record are listed, with comments, in `src/engine.ts`
(`DecisionRecord`) and `src/news/engine.ts` (`NewsRecord`). Records have no version number yet;
if you ever change their shape in a way old files wouldn't match, add one
(see [operations.md](operations.md#changing-record-formats)).

## Language and tools

The code is TypeScript, which Node.js 24 runs directly, so there's no build step. The only
check is `npm run typecheck`. Running TypeScript this way comes with a few rules, enforced in
`tsconfig.json`:

- No TypeScript-only syntax that generates code: no `enum`, no `namespace`, and no
  `constructor(private x)` shortcut. Declare class fields normally.
- Imports that only bring in types must say `import type`.
- Imports of project files include the `.ts` extension.
- Reading from an array or map might give `undefined`, and the code has to handle that.

There are only three runtime dependencies: `ai` (Vercel's AI SDK, which calls Jev),
`@ai-sdk/typesafe-ai` (for calling TypeSafe directly, bypassing the gateway), and
`fast-xml-parser` (for reading news feeds). Node's built-in `fetch` and `WebSocket` handle all
networking.
