# The live market-data loop

Code: `src/engine.ts` (the loop) and `src/live.ts` (the program that runs it). Run it with
`npm run live`.

## What it does

It keeps asking Jev about Bitcoin, as often as it's allowed, always using the freshest possible
view of the market, and records every answer together with what the price did next.

## How a decision happens

1. A market update arrives and is applied to the market state.
2. If the engine is allowed to ask Jev right now, it takes a snapshot of the market, turns it into
   text, and sends the question.
3. When Jev answers, the engine notes the time and the current price, and holds the record.
4. Sixty seconds later, it fills in the prices at 1, 2, 5, 10, 30, and 60 seconds after the
   answer, and writes the record to disk.
5. As soon as an answer comes back, it asks again with a fresh snapshot.

## When it's allowed to ask

| Check | Default | Why |
|---|---|---|
| The order book is loaded | after the first snapshot | nothing to describe before that |
| Warm-up time has passed | 60 seconds (`WARMUP_S`) | measurements like "60-second change" need 60 seconds of history; asking earlier fills Jev's text with "n/a" |
| No question already waiting | 1 at a time (`JEV_MAX_INFLIGHT`) | one at a time keeps every answer as fresh as possible |
| Minimum gap between questions | none (`JEV_MIN_INTERVAL_MS`) | ask again the moment an answer comes back |
| Not paused after "too many requests" | pause 5 s, doubling up to 60 s | respect the rate limit without hammering it |

**Why not keep several questions going at once?** You'd get more answers, but each would still be
about a third of a second old when it arrived. If you do raise `JEV_MAX_INFLIGHT`, also set
`JEV_MIN_INTERVAL_MS` so the questions are spread out rather than sent in bursts.

**Why not retry a question that was refused?** The next snapshot is just as good, and fresher.

**Why a 2-second timeout?** An answer that late would describe a market that has already moved on.

## What's recorded for each decision

| Field | Meaning |
|---|---|
| `mode`, `provider` | live or backtest; gateway, direct, or mock |
| `tState` | when the snapshot was taken |
| `exchLagMs` | how old the newest market data in the snapshot was |
| `buildMs` | time to measure the market and write the text |
| `modelMs` | how long Jev took |
| `tResp` | when Jev's answer arrived: the earliest moment anyone could act on it |
| `state` | exactly the text Jev saw, so any decision can be looked at again later |
| `probabilities` | Jev's raw answers |
| `signals` | Jev's signal for each horizon, plus four simple rules computed from the same snapshot (book imbalance at 1 and 5 levels, 5-second order flow, 5-second momentum) |
| `midState`, `midResp` | the price at the snapshot and when the answer arrived |
| `fwdState`, `fwdResp` | the prices at each horizon, measured from the snapshot and from the answer |

- **Why keep the simple rules in every record?** The real question is whether Jev beats them after
  its delay. Without them, a Jev result couldn't be judged.
- **Why store prices instead of price changes?** So the report can measure changes any way it
  likes later, without rerunning anything.
- **Why measure from two moments?** From the snapshot shows whether Jev saw something real; from
  the answer shows whether anyone could have traded on it
  ([architecture.md](architecture.md#3-every-decision-is-judged-twice)).

If the run stops before a record's 60 seconds are up, the record is still written, with "unknown"
for the prices that hadn't happened yet.

## The status line

Every 10 seconds `npm run live` prints something like:

```
mid 81028.51  ev/s 20  feed lag p50 94ms  event cost p50 45µs p99 557µs  decisions 5  written 0  model 332ms  429s 6  timeouts 0  errors 0
```

That's the price, market updates per second, how delayed the market data is, how long each
update took to handle, decisions made and written, Jev's last response time, and how many
requests were refused, timed out, or failed.

## Tested

- With the mock model on live data for 2.5 minutes: 393 decisions, about 2.6 per second, all
  written correctly, and the report scored the random answers at about zero, as it should.
- With the real gateway on the free tier: 5 real decisions each time the rate limit allowed
  (285 to 469 ms each), pausing correctly when refused.
