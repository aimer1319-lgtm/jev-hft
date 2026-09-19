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
- **Probabilities are rounded to two decimals.** Signals built from them move in steps of 0.01.
- **Answers shift a little when the input changes, even slightly.** TypeSafe's own tests show
  its top answer repeating about 91% of the time on the same input. So what we send Jev avoids
  details that change for no reason.
- It costs $0.042 per million input tokens, and its answers are free.

## `ask()`: the one way the code calls Jev

`ask()` wraps the AI SDK's `experimental_evaluate` function.

- **It never retries.** A retried answer arrives late, describing a market that has already
  moved on. Whether to try again is left to the engine, which knows how late is too late.
- **It reports "too many requests" (error 429) separately,** so engines can slow down instead of
  treating it as a failure.
- **It can be cancelled.** Engines give up on answers that take longer than `JEV_TIMEOUT_MS`
  (2 seconds).

`experimental_evaluate` is marked experimental in the AI SDK, so it might change in a future
version. `ask()` is the only place that would need updating.

## Choosing how to reach Jev

| `JEV_PROVIDER` | Route |
|---|---|
| `gateway` (default) | through Vercel AI Gateway, using `AI_GATEWAY_API_KEY` and model `typesafe-ai/jev` |
| `typesafe` | straight to TypeSafe's own API, using `TYPESAFE_AI_API_KEY` |
| `mock` | no network at all: random answers after a realistic delay |

**Why the gateway is the default:** the project was set up around it: one key, one bill, one
dashboard. **Why the direct route exists:** most of the gateway's round trip is spent in the
gateway itself (see [latency.md](latency.md)), so going direct is the biggest speed-up
available. It hasn't been tested yet because it needs a TypeSafe key. Switching is one setting;
nothing else in the code changes.

## The market-data questions

For the market-data path, Jev gets three questions per call, one for each time horizon:

- "Where will the price be **2 seconds** from now?" Up by more than 0.5 bp, down by more than
  0.5 bp, or within 0.5 bp.
- The same for **10 seconds** (1 bp) and **60 seconds** (3 bp).

The signal is the chance of "up" minus the chance of "down", a number between −1 and +1.

- **Three horizons,** because we don't know which one (if any) Jev can see; extra ones are nearly
  free.
- **A "flat" option,** so Jev isn't forced to guess up or down when nothing is likely to happen.
- **Exact thresholds,** so the options mean the same thing every time.

**Known weakness:** in quiet markets these thresholds are wide compared with how little the price
actually moves, so most honest answers are "flat". The report compares the signal with the actual
moves on a sliding scale, so it still works, but tighter thresholds are worth trying. They're
all set in `DIRECTIONS`.

## The mock model

`JEV_PROVIDER=mock` answers every question with random but valid probabilities after about
375 ms (`MOCK_LATENCY_MS`). It's there for two reasons:

1. **Free testing.** You can run the whole pipeline without spending money or hitting rate limits.
2. **Checking the reports.** A model that answers randomly should score about zero. It did, which
   shows the reports aren't accidentally peeking at future prices.

## Ideas for later

- **Averaging:** ask the same question a few times in parallel and average the answers, to
  smooth out Jev's small random shifts. It costs more but takes no extra time.
- **Using Jev's confidence score:** TypeSafe also returns a confidence number that could be used
  to skip unsure answers.
- **Racing two requests:** send the same request twice and use whichever answers first, to cut
  down the occasional slow response.
