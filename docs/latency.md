# Where the time goes

When we started, the assumption was that the slow part would be collecting market data and
squeezing it into a form the model can read. Measuring every step showed otherwise: **the slow
part is the round trip to Jev.** For news, an even bigger delay comes first: how long it takes
to notice that something was published at all.

All numbers below were measured on 2026-09-19 from a laptop on a US West Coast home internet
connection, using Bitcoin data from Coinbase during a quiet weekend market. Re-measure before
relying on them in a different setup (`npm run bench`, and the reports print the same breakdown
for any run).

## From an exchange event to a usable decision

This is the chain for the market-data path: something happens on Coinbase, we hear about it,
we summarize it, and Jev answers.

| Step | Typical time | How it was measured |
|---|---|---|
| Coinbase holds the update before sending it | 47 ms for order book changes, 85 ms for trades | Coinbase stamps both when the event happened and when the message was sent |
| Coinbase to our machine over the internet | 32 ms | when the message arrived vs when Coinbase sent it |
| Processing one market update | 0.02 to 0.05 ms | timed around the code that applies each update |
| Measuring the market and writing Jev's text | 0.25 to 0.6 ms | recorded with every decision |
| **Jev's answer through the gateway** | **about 260 ms** (slow case about 320 ms) | timed on our side, on an already-open connection |
| **Total** | **about 0.37 seconds** (slow case 0.49) | the "exchange event -> decision" line in the report |

Two things stand out. The model's round trip is several times longer than the market data's
journey, and about a thousand times longer than all our own processing. And the 47 to 85 ms that
Coinbase holds updates before sending them can't be avoided by anyone using its free public
feed; only the 32 ms internet trip would shrink if the machine were closer to Coinbase.

## Inside the Jev round trip

A request goes from our machine to Vercel's nearest server (San Francisco), then to the
gateway's main servers (Cleveland), then to TypeSafe (US West Coast), and all the way back.

| Measurement | Typical time | What it shows |
|---|---|---|
| A request for a model that doesn't exist (the gateway rejects it immediately) | 95 ms | just the trip to the gateway and back |
| The gateway's own record of how long it waited for TypeSafe | 160 ms | gateway to TypeSafe and back, including Jev's thinking time |
| A full successful request | 257 ms (slow case 318 ms) | everything |
| The same request on a brand-new connection | 360 ms | about 100 ms extra to connect and set up encryption |
| A request straight to TypeSafe's own servers, refused for having no key | 40 ms | the network trip we would have without the gateway |

Put together: about 95 ms to reach the gateway and come back, and about 160 ms for the gateway to
get an answer from TypeSafe. Roughly 60 ms of that second part is the Cleveland to West Coast
trip, which leaves about 100 ms for Jev itself. That matches TypeSafe's published claim that most
requests take about 100 ms. **So more than half of the round trip is the route, not the model.**

Every record stores both numbers (`modelMs` for the whole round trip, `providerMs` for
TypeSafe's part as the gateway reports it), so the reports show this split for any run.

We measured the same thing twice on the same day and got different totals: about 370 ms in the
early hours, when the account was on the gateway's rate-limited free tier, and about 260 ms in
the evening, after the account had credits. TypeSafe's part was the same both times (150 to
160 ms); the gateway's own part shrank. We can't tell from outside whether that was the free
tier's extra checks or simply the time of day.

## Keeping the connection open

Opening a new encrypted connection costs about 100 ms, and sometimes much more (we saw one take
7 seconds). Node.js closes a connection that has been idle for 4 seconds, and the gateway closes
one that has been idle for somewhere between 30 and 60 seconds.

That doesn't matter for the market-data path, which asks Jev every second. It matters a lot for
news, where calls are minutes apart: every news decision was paying for a new connection.

So calls to Jev get their own connection settings (`src/model/jev.ts`): idle connections are
kept for 25 seconds, and a tiny request goes out every 20 seconds so the connection is never idle
long enough for either side to close it. Measured with news items 25 seconds apart: **255 to
300 ms per decision, down from 460 to 550 ms.** Only the first call after starting the program is
still slow (about half a second).

Two details that took a while to find and are worth knowing:

- The tiny request must be a `GET`. Node's HTTP client deliberately closes the connection after
  every `HEAD` request, which would do the opposite of what we want.
- It goes to the same address as real Jev calls and is refused instantly ("405 method not
  allowed"). It carries no key, reaches no model, and costs nothing. Requests to addresses the
  gateway doesn't know are answered with an instruction to close the connection, so those can't
  be used either.

## Noticing news

For the news path, the biggest delay by far is between a publisher putting something out and
our program seeing it. Jev's quarter of a second barely registers next to it.

| Source | How we hear | Delay we add |
|---|---|---|
| Benzinga newswire (through Alpaca) | pushed to us | none beyond the network |
| Federal Reserve, Coinbase status | we check every 10 seconds | 5 seconds on average |
| SEC filings | we check every 10 seconds | 5 seconds on average |
| X accounts | we search every 10 seconds | 5 seconds on average, plus X's own indexing delay |
| CoinDesk | we check every 30 seconds | 15 seconds on average, and the site's own cache can be minutes old |
| Cointelegraph | we check every 10 seconds | the site only refreshes its feed every 5 minutes |
| CFTC | we check every 10 seconds | the site only refreshes its feed every 30 minutes |

**Why some feeds are checked three times as often as others.** A well-run feed can answer "nothing
has changed" without sending anything. That reply is empty and takes about 25 ms, so asking often
costs the site almost nothing. The Fed, CFTC, Coinbase status, and Cointelegraph feeds do this.
CoinDesk's feed and the SEC's filing list send their full content (about 30 KB) on every check,
so they'd normally be checked every 30 seconds. The SEC feed is the exception: filings move
prices within minutes, and the SEC explicitly allows up to 10 requests a second, so it's checked
every 10 seconds anyway. The feed reader works out which kind each feed is by itself
([news.md](news.md#sources)).

**What no amount of checking fixes.** Several sites put a cache in front of their feed. The CFTC's
copy can be 30 minutes old and Cointelegraph's 5 minutes old no matter how often we ask. For
anything where seconds matter, a pushed source like Benzinga is the only real answer.

**X is checked often because that's free.** X charges for each post it returns, not for each
search. A search that finds nothing costs nothing.

## What doesn't change the speed

| What we changed | Result | What it means |
|---|---|---|
| Size of the text sent to Jev: 446, then 1,687, then 6,633 tokens | 257, 254, 274 ms | Shorter text saves money (15 times cheaper across this range), not time. |
| Number of questions per request: 1, 4, 16 | 257, 268, 277 ms | Jev answers questions in parallel, so asking several at once is nearly free in time. |
| 8 requests at the same moment | 282 ms each | Asking about many things at once doesn't slow any of them down. |

## What this meant for the design

1. **Our own code doesn't need to be faster.** It's a tiny fraction of the total, which is why
   the project is simple single-threaded TypeScript.
2. **The biggest time saving available is skipping the gateway.** TypeSafe's own servers answer
   us in about 40 ms, against 95 ms for the gateway's fastest possible reply. Calling TypeSafe
   directly (`JEV_PROVIDER=typesafe`) should bring a decision down to about 150 ms. This hasn't
   been tried, because it needs a separate TypeSafe API key. At that point, Coinbase's own
   sending delay would matter about as much as the model.
3. **This isn't high-frequency trading.** Even the fastest route gives decisions about 0.2
   seconds after something happens. High-frequency firms react in millionths of a second. This
   project aims at horizons from seconds to minutes.
4. **Trading costs matter more than speed at short horizons.** In our recorded data, Bitcoin's
   average price move was 0.05 to 0.1 bp over 1 second, 0.5 to 0.9 bp over 10 seconds, and 1 to
   4 bp over 60 seconds. A round trip of buying and selling costs around 10 bp. No amount of
   speed fixes that gap, which is why the news path exists: news can move prices by far more.
5. **For news, being told beats asking.** Seconds are lost waiting for the next check, not
   waiting for Jev.

## Rate limits

An AI Gateway account **without credits** is limited to about 5 Jev requests every 5 minutes. We
found this by sending one request every 4 seconds for 15 minutes: exactly five succeeded in a
row at 192, 496, and 796 seconds in, and the rest were refused with error 429 and the message
"Free tier requests on this model are rate-limited. Upgrade to paid credits ... for unrestricted
access." Refused requests never reach TypeSafe.

**With credits on the account we saw no limit:** 69 decisions in 75 seconds at one a second, and
about 170 benchmark requests in a row, without a single refusal.

Both engines still treat a refusal as "slow down" ([engine.md](engine.md), [news.md](news.md)),
so the pipeline behaves sensibly on either kind of account.

## Costs

Jev charges $0.042 per million input tokens; its answers are free. The gateway reports what each
call costs, and every record stores it (`costUsd`), so reports and status lines show real totals
rather than estimates.

What a call costs, in tokens:

- about 300 tokens of fixed overhead on every call,
- plus the text we send, **counted once however many questions we ask about it**,
- plus 35 to 95 tokens per question, depending on how long its wording is.

That's why one call about three assets is much cheaper than three calls, and why adding a few
lines of context to a news item is nearly free.

| What | Tokens | Cost |
|---|---|---|
| A market-data decision (three questions plus the market summary) | about 820 to 855 | about $0.000035 |
| A news decision about one asset | about 580 to 650 | about $0.000025 |
| A news decision about two assets | about 800 | about $0.000034 |
| Asking about the market once a second, all day | | about $3 a day |
| The same, back to back (about 2.7 a second) | | about $8 a day |
| 10,000 backtest decisions | | about $0.35 |

## Measuring again

- `npm run bench` measures the gateway round trip in detail, including TypeSafe's part
  ([benchmark.md](benchmark.md)).
- `npm run live` prints the market-data delay, processing time, and running cost every 10
  seconds, and `npm run analyze` prints the full chain for a finished run.
- `npm run analyze:news` prints how long each source took to reach us and how long Jev took.
- To check your computer's clock (it affects the market-data delay numbers), run
  `sntp time.apple.com` on a Mac or `timedatectl` on Linux.
