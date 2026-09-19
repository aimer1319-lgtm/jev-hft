# jev

A research project that tests whether **Jev**, a fast AI model from TypeSafe AI, can judge
market data and news quickly and accurately enough to matter for trading. Jev is reached
through **Vercel AI Gateway**.

It only paper-trades: it records what it would decide and what prices did next. It never
places real trades, and nothing here is investment advice.

## What it does

There are two parts, and each can be run on its own:

- **The news part** (`npm run news`) collects news as it's published, from public news feeds,
  the Benzinga newswire (through Alpaca), new SEC filings, and a few official X accounts. For
  each item it works out which assets it's about (Bitcoin, a US stock, or the market as a whole)
  and asks Jev: is this relevant, which way would it push the price, how big a move, and is it
  actually new? Then it records what the prices did over the next 30 minutes.
- **The market-data part** (`npm run live`) watches Bitcoin's order book and trades on Coinbase,
  sums up what's happening in a few lines of text, and asks Jev whether the price will be higher,
  lower, or about the same in 2, 10, and 60 seconds.

Reports (`npm run analyze:news`, `npm run analyze`) then check how often Jev was right, and
whether its answers came fast enough to act on.

## What we've found so far

- **Speed:** Jev answers in about a third of a second through the gateway. Most of that time is
  the gateway itself, not the model.
- **The market-data part has a cost problem:** over a few seconds Bitcoin barely moves, so even
  perfect predictions would earn less than trading fees. That's why the news part exists.
- **Jev understands the news questions:** on test headlines it called a surprise rate cut
  bullish, an exchange halting withdrawals bearish, and a bakery award irrelevant, in 0.3 to 0.6
  seconds. Whether that makes money needs real data collected over time.

## Getting started

You need **Node.js 24**.

```bash
npm install
cp .env.example .env && chmod 600 .env   # then fill in your keys
```

Keys go in `.env`, which is private and never committed. Every npm script loads it for you.

| Key | Needed for |
|---|---|
| `AI_GATEWAY_API_KEY` | reaching Jev through Vercel AI Gateway |
| `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY` | US stock prices and the Benzinga news stream (free Alpaca account) |
| `X_BEARER_TOKEN` | reading posts from X's official API (paid per post) |
| `NEWS_USER_AGENT` | your name and email, which the SEC requires for its filing feed |

Any source whose key is missing is simply skipped. To try everything without spending anything,
use the practice model, which gives random answers:

```bash
JEV_PROVIDER=mock NEWS_MANUAL=1 npm run news   # type headlines like "$AAPL beats earnings"
```

## Commands

```bash
npm run news                              # the news part, live
npm run live                              # the market-data part, live
npm run record                            # save Coinbase market data to disk
npm run backtest -- data/raw/<file>       # replay saved data and ask Jev about it
npm run analyze:news -- data/decisions/news-<file>.jsonl
npm run analyze -- data/decisions/<file>.jsonl
npm run bench                             # measure Jev's response time
npm run typecheck
```

## Limits to know about

- **Vercel AI Gateway free tier:** about 5 Jev calls every 5 minutes. That's enough for the news
  feeds, SEC filings, and X, but not for the busy Benzinga stream during market hours or the
  market-data part. Paid credits remove the limit. Jev itself costs $0.042 per million input
  tokens, a few thousandths of a cent per decision.
- **Alpaca free plan:** stock prices from one exchange, for up to 30 stocks at a time, and they
  can be unreliable outside trading hours. The pipeline handles both.
- **X:** each post read costs $0.005. A daily cap (default 500 posts, at most $2.50) keeps costs
  down; with the default accounts it's usually cents a day.

## Learn more

The [docs](docs/README.md) explain how every part works and why it's built the way it is, in
plain language. Good places to start:

- [How it all fits together](docs/architecture.md)
- [Where the time goes](docs/latency.md)
- [The news path](docs/news.md)
- [Running it, settings, and a Raspberry Pi guide](docs/operations.md)
- [Design decisions](docs/decisions.md)
