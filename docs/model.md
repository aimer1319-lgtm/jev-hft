# Talking to Jev

Code: `src/model/jev.ts`.

## What Jev is

Jev, from TypeSafe AI, doesn't write text. You give it some **state** (a piece of text or
data) and a set of named **questions**, and it answers each question with probabilities:

| Question type | Answer |
|---|---|
| **choice**: pick one of several options | the chosen option, plus the probability of each option |
| **score**: rate on a scale of levels | a score on that scale, plus the probability of each level |
| **yes/no** (TypeSafe calls it "noul") | the probability of yes |

A few things about Jev shaped the code:

- **It answers all questions at the same time,** so asking several questions costs almost no
  extra time. That's why every call asks about several horizons or several assets at once.
- **The text is counted once, however many questions are asked about it.** A call costs about 300
  tokens of overhead, plus the text, plus 35 to 95 tokens per question. So one call about three
  things is much cheaper than three calls ([latency.md](latency.md#costs)).
- **Probabilities are rounded to two decimals.** Signals built from them move in steps of 0.01.
- **The same question gets very nearly the same answer.** We sent one request three times and the
  answers differed by 0.01 to 0.03. So asking the same thing several times and averaging buys
  almost nothing, and the code doesn't do it.
- **It also says how sure it is** of each choice and score answer (a "confidence" from 0 to 1).
  Every record keeps it.
- It costs $0.042 per million input tokens, and its answers are free.

## `ask()`: the one way the code calls Jev

`ask()` wraps the AI SDK's `experimental_evaluate` function.

- **It never retries.** A retried answer arrives late, describing a market that has already
  moved on. Whether to try again is left to the engine, which knows how late is too late: the
  market-data engine never does, the news engine does up to twice.
- **It reports "too many requests" (error 429) separately,** so engines can slow down instead of
  treating it as a failure.
- **It can be cancelled.** Engines give up on answers that take too long (2 seconds for market
  data, 5 for news).
- **It returns what the gateway says about the call** alongside the answers: tokens used, what it
  cost, how long TypeSafe itself took, and Jev's confidence. That's how every record and status
  line can show real costs and where the time went.

Two helpers say what kind of failure happened. `isTimeout()` recognizes a timeout even when the
gateway has wrapped it inside its own error, which it does. `isTransient()` says whether a
failure is worth another try: timeouts, network trouble, and errors on the server's side are; a
rejected key or a malformed request isn't.

`experimental_evaluate` is marked experimental in the AI SDK, so it might change in a future
version. `ask()` is the only place that would need updating.

## Choosing how to reach Jev

| `JEV_PROVIDER` | Route |
|---|---|
| `gateway` (default) | through Vercel AI Gateway, using `AI_GATEWAY_API_KEY` and model `typesafe-ai/jev` |
| `typesafe` | straight to TypeSafe's own API, using `TYPESAFE_AI_API_KEY` |
| `mock` | no network at all: random answers after a realistic delay |

**Why the gateway is the default:** the project was set up around it: one key, one bill, one
dashboard. **Why the direct route exists:** more than half of the gateway's round trip is the
route rather than the model (see [latency.md](latency.md)), so going direct is the biggest
speed-up available: TypeSafe's servers answer us in about 40 ms, which points to decisions in
about 150 ms instead of 260. It hasn't been tested yet because it needs a TypeSafe key. Switching
is one setting; nothing else in the code changes.

## Keeping the connection open

Calls to Jev use their own connection settings, and `keepWarm()` makes a tiny request every 20
seconds, so there's always an open connection ready. Without this, any call made more than 4
seconds after the last one first spends about 100 ms opening a new encrypted connection. That
was every single news decision. The measurements and the two non-obvious details (it has to be a
`GET`, and it has to go to the address real calls use) are in
[latency.md](latency.md#keeping-the-connection-open).

This applies only to Jev's connection. Everything else (news feeds, Alpaca, X) keeps Node's
normal behaviour.

## The market-data questions

For the market-data path, Jev gets three questions per call, one for each time horizon:

- "Where will the price be **2 seconds** from now?" Up by more than *x* bp, down by more than
  *x* bp, or within *x* bp.
- The same for **10 seconds** and **60 seconds**.

The signal is the chance of "up" minus the chance of "down", a number between −1 and +1.

- **Three horizons,** because we don't know which one (if any) Jev can see; extra ones are nearly
  free.
- **A "flat" option,** so Jev isn't forced to guess up or down when nothing is likely to happen.
- **Exact thresholds,** so the options mean the same thing every time.

### What counts as "flat" follows the market

*x* isn't fixed. It's two typical moves for that horizon at the moment of asking: the current
second-to-second volatility, scaled up to 2, 10, or 60 seconds, doubled, rounded to 0.1 bp, and
never below 0.1 bp (`flatThresholds()`; the multiplier is `JEV_FLAT_SIGMAS`, default 2).

**Why scale at all:** a fixed threshold suits one kind of market. In a market five times busier,
nearly every move would count as "up" or "down" and "flat" would stop meaning anything; in a dead
market nothing would ever count. Scaling keeps the question equally meaningful in both. The
original fixed thresholds (0.5, 1, and 3 bp) sit between one and two typical moves on the quiet
nights we've measured, so this keeps roughly their meaning and carries it to other conditions.

**Why two typical moves:** we asked Jev about the same recorded snapshots four ways (fixed
thresholds, then half, one, and two typical moves), on a 31-minute recording (372 decisions
each) and a shorter one.

| "Flat" means | How well Jev ranked the next move, at 2 s / 10 s | Answers stuck beyond ±0.9, at 10 s / 60 s |
|---|---|---|
| fixed 0.5 / 1 / 3 bp | 0.10 / 0.12 | 3% / 4% |
| half a typical move | 0.11 / 0.14 | 8% / 23% |
| one typical move | 0.11 / 0.15 | 5% / 14% |
| two typical moves | 0.13 / 0.17 | 2% / 1% |

Accuracy didn't tell them apart: two settings that happened to give nearly the same thresholds
still differed by 0.03 to 0.05, so that's just noise. What did differ is how often Jev's answer
was pinned at "almost certainly up" or "almost certainly down". The narrower the band, the more
often that happened, and an answer that's always extreme can't rank anything. We had first
guessed that a narrow band (three equally likely answers) would carry the most information. The
data said otherwise, so the default is the widest setting we tested.

The thresholds each decision was asked with are saved in its record, and the report judges every
answer against its own ([backtest-and-analysis.md](backtest-and-analysis.md)). `JEV_FLAT_SIGMAS=0`
goes back to the fixed thresholds in `DIRECTIONS`, which are also used whenever volatility isn't
known yet. Thanks to the backtest's answer cache, trying another value on a recording you've
already used only pays for the new questions.

### What Jev has shown on market data so far

On the 31-minute recording (a quiet Saturday evening, so one kind of market only):

| | 2 seconds ahead | 10 seconds ahead | 60 seconds ahead |
|---|---|---|---|
| Jev | 0.10 to 0.13 | 0.12 to 0.17 | about 0 |
| Top-of-book imbalance (one line of arithmetic) | 0.22 | 0.25 | 0.20 |
| Jev, once the simple rules are accounted for | −0.10 to −0.14 | about 0 | about 0 |

(Rank correlation with the next price move; 0 means no relationship. The ranges cover the four
threshold settings. The 2- and 10-second numbers rest on hundreds of separate moments; the
60-second ones on only 30, so treat those as rough.)

- **Jev does pick something up**, but about half as much as the simplest rule, which costs nothing
  and takes no time.
- **It adds nothing the rules don't already say.** Jev is shown the same numbers the rules are
  built from. Once what the rules explain is removed, nothing of Jev's signal is left, and at 2
  seconds what's left points slightly the wrong way.
- **Its probabilities are far too confident.** When it said 80 to 100%, the move happened about
  one time in ten.
- **It leaned "down" all evening** (about 0.4 to 0.5 for down against 0.05 to 0.1 for up) in a
  market that went nowhere.

This is one evening, and a busier market may look different. But it fits the rest of what we've
found: reading an order book is arithmetic, which simple rules already do well, while judging
what a headline means is language, which is what Jev is for.

## The mock model

`JEV_PROVIDER=mock` answers every question with random but valid probabilities after about
375 ms (`MOCK_LATENCY_MS`). It's there for two reasons:

1. **Free testing.** You can run the whole pipeline without spending money or hitting rate limits.
2. **Checking the reports.** A model that answers randomly should score about zero. It did, which
   shows the reports aren't accidentally peeking at future prices.

The tests use a different stand-in, a scripted model that can be told to fail in specific ways
([testing.md](testing.md)).

## Ideas for later

- **Using Jev's confidence:** it's recorded now. Once there's enough data, the news report's
  "which way of combining the answers ranks moves best" table will show whether weighting by it
  helps.
- **Racing two requests:** send the same request twice and use whichever answers first, to cut
  down the occasional slow response. It doubles the cost.
- **Shorter question wording:** questions are most of what a market-data call costs. Shorter
  wording would save perhaps 10%, but might change Jev's answers, so it needs a backtest first.
- **Asking Jev a different kind of market question.** It doesn't beat simple rules at "which way
  next". Questions that need judgment rather than arithmetic ("does this look like one large buyer
  working an order?") might suit it better, and the "beyond the rules" line in the report is how
  to tell.
