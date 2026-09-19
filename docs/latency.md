# Where the time goes

When we started, the assumption was that the slow part would be collecting market data and
squeezing it into a form the model can read. Measuring every step showed otherwise: **the slow
part is the round trip to Jev, and most of that is Vercel's gateway, not Jev itself.** This
page shows the measurements and what they mean for the design.

All numbers below were measured on 2026-09-19 from a laptop on a US West Coast home internet
connection, using a free-tier AI Gateway account and Bitcoin data from Coinbase, during a quiet
overnight market. Re-measure before relying on them in a different setup.

## From an exchange event to a usable decision

This is the chain for the market-data path: something happens on Coinbase, we hear about it,
we summarize it, and Jev answers.

| Step | Typical time | How it was measured |
|---|---|---|
| Coinbase holds the update before sending it | 47 ms for order book changes, 85 ms for trades | Coinbase stamps both when the event happened and when the message was sent |
| Coinbase to our machine over the internet | 32 ms | when the message arrived vs when Coinbase sent it |
| Processing one market update | 0.02 to 0.05 ms | timed around the code that applies each update |
| Measuring the market and writing Jev's text | 0.25 to 0.6 ms | recorded with every decision |
| **Jev's answer through the gateway** | **about 350 ms** (slow case about 550 ms) | timed on our side, on an already-open connection |
| **Total** | **about 0.45 to 0.5 seconds** | the "exchange event -> decision" line in the report |

Two things stand out. The model's round trip is more than ten times longer than the market
data's journey, and about a thousand times longer than all our own processing. And the
47 to 85 ms that Coinbase holds updates before sending them can't be avoided by anyone using
its free public feed; only the 32 ms internet trip would shrink if the machine were closer to
Coinbase.

## Inside the Jev round trip

A request goes from our machine to Vercel's nearest server (San Francisco), then to the
gateway's main servers (Cleveland), then to TypeSafe (US West Coast), and all the way back. We
split that trip into parts with three measurements:

| Measurement | Typical time | What it shows |
|---|---|---|
| A request for a model that doesn't exist (the gateway rejects it immediately) | 107 ms | just the network trip to the gateway and back |
| A request rejected by the free tier's rate limit | about 180 to 215 ms | the above, plus about 70 ms of gateway checks (key, credits, limits) |
| The gateway's own record of how long it waited for TypeSafe | 153 ms | gateway to TypeSafe and back, including Jev's thinking time |
| A full successful request | 368 ms | everything (15 samples, from 262 to 662 ms) |

Put together: about 107 ms of network to reach the gateway, about 70 ms of gateway checks, and
about 150 ms for the TypeSafe part. Roughly 55 ms of that last part is the Cleveland to West
Coast trip, which leaves about 100 ms for Jev itself. That matches TypeSafe's published claim
that most requests take about 100 ms. **So about 250 ms of the 350 ms is the gateway route, not
the model.**

Opening a fresh connection adds more: about 22 ms to connect and 28 ms to set up encryption, so
a first request takes about 460 to 550 ms. After that, connections are reused automatically.

## What doesn't change the speed

| What we changed | Result | What it means |
|---|---|---|
| Size of the text sent to Jev: 446, then 1,687, then 6,633 tokens | TypeSafe part stayed around 120 to 170 ms | Shorter text saves money (15 times cheaper across this range), not time. |
| Number of questions per request: 1, 4, 16 | TypeSafe part stayed around 120 to 190 ms | Jev answers questions in parallel, so asking several at once is nearly free in time. |

## What this meant for the design

1. **Our own code doesn't need to be faster.** It's a tiny fraction of the total, which is why
   the project is simple single-threaded TypeScript.
2. **The biggest time saving available is skipping the gateway.** Calling TypeSafe directly
   (`JEV_PROVIDER=typesafe`) from a West Coast machine should bring the round trip close to
   100 ms. This hasn't been tried, because it needs a separate TypeSafe API key. At that point,
   Coinbase's own sending delay would matter about as much as the model.
3. **This isn't high-frequency trading.** Even the fastest route gives decisions about 0.2
   seconds after something happens. High-frequency firms react in millionths of a second. This
   project aims at horizons from seconds to minutes.
4. **Trading costs matter more than speed at short horizons.** In our recorded data, Bitcoin's
   average price move was 0.05 bp over 1 second, 0.47 bp over 10 seconds, and 0.95 bp over 60
   seconds. A round trip of buying and selling costs around 10 bp. No amount of speed fixes
   that gap, which is why the news path exists: news can move prices by far more.

## Rate limits

On the free tier of AI Gateway, Jev allows about **5 successful requests every 5 minutes**. We
found this by sending one request every 4 seconds for 15 minutes: exactly five succeeded in a
row at 192, 496, and 796 seconds in, and the rest were refused with error 429 and the message
"Free tier requests on this model are rate-limited. Upgrade to paid credits ... for unrestricted
access." Refused requests never reach TypeSafe. Both engines treat a refusal as "slow down"
([engine.md](engine.md), [news.md](news.md)).

## Costs

Jev charges $0.042 per million input tokens; its answers are free. A market-data decision
(three questions plus the market summary) is about 855 tokens, roughly $0.000036. So 10,000
backtest decisions cost about $0.36, and asking Jev continuously, back to back, all day (about
2.7 decisions a second) would cost about $8 a day.

## Measuring again

- `npm run bench` measures the gateway round trip in detail ([benchmark.md](benchmark.md)).
- `npm run live` prints the market-data delay and processing time every 10 seconds, and
  `npm run analyze` prints the full chain for a finished run.
- To check your computer's clock (it affects the market-data delay numbers), run
  `sntp time.apple.com` on a Mac or `timedatectl` on Linux.
