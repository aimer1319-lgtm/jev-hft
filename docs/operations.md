# Running and maintaining it

## Commands

| Command | What it does | Where results go |
|---|---|---|
| `npm run news` | the news path, for Bitcoin and US stocks | `data/decisions/news-...jsonl` and `data/news/items-...jsonl` |
| `npm run live` | the market-data path, live | `data/decisions/live-...jsonl` |
| `npm run record` | saves Coinbase market data | `data/raw/BTC-USD-...jsonl.gz` |
| `npm run backtest -- <file>` | replays saved data and asks Jev about it | `data/decisions/backtest-...jsonl` |
| `npm run analyze -- <files>` | report for the market-data path | printed |
| `npm run analyze:news -- <files>` | report for the news path | printed |
| `npm run bench` | measures Jev's response time | printed |
| `npm run example` | the smallest possible Jev call | printed |
| `npm run typecheck` | checks the code for type errors | printed |

Every runner stops cleanly with Ctrl-C, when the system shuts it down, or after `RUN_MINUTES`.
Try anything new with `JEV_PROVIDER=mock` first: it's free and has no rate limits.

## Setup

1. Install **Node.js 24**.
2. Run `npm install` in the project folder.
3. Copy `.env.example` to `.env`, fill in your keys, and make it private: `chmod 600 .env`.

Every npm script loads `.env` automatically. If a setting is also defined in your shell, the
shell's value wins. On the development Mac, `~/.zshrc` also sets `AI_GATEWAY_API_KEY` (from the
macOS Keychain, via Vercel's setup), so if you ever replace that key, update it in both places.

## Settings

Everything is read in `src/config.ts`. A blank value means "use the default". Number settings
are checked at startup, and an invalid one (like `STEP_S=abc`) stops the program with a clear
message.

**Keys and accounts**

| Setting | What it's for |
|---|---|
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway key (needed to reach Jev) |
| `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY` | Alpaca keys: stock prices and the Benzinga news stream |
| `X_BEARER_TOKEN` | X API read-only key |
| `NEWS_USER_AGENT` | your name and email, required by the SEC for its filing feed |
| `TYPESAFE_AI_API_KEY` | only for going straight to TypeSafe (`JEV_PROVIDER=typesafe`) |

**General**

| Setting | Default | Meaning |
|---|---|---|
| `JEV_PROVIDER` | `gateway` | `gateway`, `typesafe` (direct), or `mock` (free random answers) |
| `AI_GATEWAY_MODEL` | `typesafe-ai/jev` | the model's name on the gateway |
| `MOCK_LATENCY_MS` | `375` | how long the mock takes to answer |
| `JEV_MAX_INFLIGHT` | `1` | questions to Jev at the same time |
| `JEV_TIMEOUT_MS` | `2000` | give up on answers slower than this |
| `RUN_MINUTES` | `0` | stop after this many minutes (0 means run until stopped) |
| `FEE_BPS` | `10` | trading cost used by the reports; set it to what your broker charges |

**News path**

| Setting | Default | Meaning |
|---|---|---|
| `NEWS_SOURCES` | `rss,alpaca,edgar,x` | which sources to run; each is skipped with a message if its key is missing |
| `NEWS_FEEDS` | 5 public feeds | your own list of feeds, as `name=url` pairs (custom feeds count as Bitcoin news) |
| `NEWS_POLL_S` | `30` | seconds between feed checks (minimum 5) |
| `NEWS_MANUAL` | off | `1` lets you type headlines for testing (`$AAPL`, `$BTC` pick the asset) |
| `NEWS_MAX_SYMBOLS` | `3` | most assets per news item |
| `NEWS_MAX_AGE_S` | `300` | drop items that have waited this long for Jev |
| `ALPACA_FEED` | `iex` | `iex` is the free plan; `sip` needs Alpaca's paid plan |
| `ALPACA_MAX_SYMBOLS` | `30` | stocks watched at once (the free plan's limit) |
| `X_ACCOUNTS` | 6 official accounts | X accounts to follow, separated by spaces or commas |
| `X_POLL_S` | `30` | seconds between X checks |
| `X_MAX_POSTS_PER_DAY` | `500` | X posts read per day before pausing (each costs $0.005) |
| `RELEVANT_P` | `0.5` | how sure Jev must be for the report to count an item as relevant |
| `MAX_SPREAD_BPS` | `50` | the report ignores stock prices with a wider spread than this |
| `SHOW` | `25` | how many items the news report lists |

**Market-data path**

| Setting | Default | Meaning |
|---|---|---|
| `PRODUCT` | `BTC-USD` | Coinbase product to watch |
| `JEV_ENCODING` | `compact` | `compact` (labeled lines) or `json` |
| `JEV_MIN_INTERVAL_MS` | `0` | minimum time between questions |
| `WARMUP_S` | `60` | history to collect before asking Jev |
| `STEP_S`, `BT_LATENCY_MS`, `BT_CONCURRENCY`, `BT_MAX` | 5, 375, 4, all | backtest: seconds between snapshots, pretend delay, questions at once, maximum snapshots |
| `BENCH_N` | `20` | benchmark samples per scenario |

## Costs and limits

- **Jev:** $0.042 per million input tokens. A decision costs a few thousandths of a cent.
- **AI Gateway free tier:** about 5 Jev calls every 5 minutes. Enough for the news feeds, SEC
  filings, and X; not enough for the Benzinga stream during market hours, the live market-data
  path, or big backtests. Paid credits remove the limit.
- **Alpaca free plan:** stock prices from one exchange (IEX), up to 30 stocks at a time. Prices can
  be very wide outside trading hours.
- **X:** $0.005 per post read. The daily cap (`X_MAX_POSTS_PER_DAY`, default 500) keeps it under
  $2.50 a day; with the default accounts it's usually cents.
- **Coinbase, the public news feeds, and the SEC:** free.

## Running on a Raspberry Pi

A Raspberry Pi 5 with 8 GB of memory runs this comfortably. Measured on the development machine:
the news program peaked at 175 MB of memory and used about 2.6% of one processor core; the
market-data program 158 MB and about 2.4%. The Pi's processor is roughly two to three times
slower, so expect about 5 to 8% of one core each. Nearly all the time is spent waiting on the
network, so it will be just as fast on the same internet connection.

**Setting it up takes one script.** Clone the repo on the Pi, copy your `.env` over, and run
`./deploy/pi/setup.sh`. It installs Node.js 24 if needed, installs the packages, checks your keys,
and sets the news pipeline up as a background service that starts at boot, waits for the clock to
sync, restarts itself after a crash, and saves its pending records when stopped. Step-by-step
instructions and everyday commands are in [deploy/pi/README.md](../deploy/pi/README.md).

A few tips:

- Use the 64-bit Raspberry Pi OS, and a network cable rather than Wi-Fi if you can.
- If you'll also save market data around the clock (`--service record`, about 260 MB a day), use
  an SSD rather than the SD card, since constant writing wears SD cards out.
- A sudden power cut loses up to 30 minutes of pending news decisions; a normal stop or restart
  doesn't.

**Don't run it on the Pi and another computer at the same time.** Alpaca's free plan allows one
connection per stream, so the second copy would be refused. The gateway's free-tier limit would
be shared, and X costs would double.

## Fixing common problems

| What you see | Why | What to do |
|---|---|---|
| "Free tier requests on this model are rate-limited" / many `429s` | the gateway's free-tier limit | wait, ask less often, or add gateway credits; the engines already slow down |
| `GatewayAuthenticationError` | `AI_GATEWAY_API_KEY` missing from `.env`, or no longer valid | add it; if it was revoked, create a new one with `vercel ai-gateway api-keys create` |
| `no Alpaca keys ... stock instruments will have no prices` | Alpaca keys missing from `.env` | add `ALPACA_API_KEY_ID` and `ALPACA_API_SECRET_KEY` |
| `[alpaca ...] error 402` | Alpaca keys wrong or revoked | make new ones in the Alpaca dashboard |
| `[alpaca ...] error 406` | another copy is already connected to Alpaca | run only one copy |
| `over-limit` in the stocks status | more than 30 stocks needed at once | expected on the free plan; those records get no later prices |
| stock records left out of the report | their spread was too wide (usually outside trading hours) | expected; look at regular-session results |
| `edgar skipped: set NEWS_USER_AGENT` | the SEC requires identification | set your name and email in `.env` |
| `[news:x] HTTP 401` | X key wrong or revoked | make a new one in the X developer portal |
| `[news:x] HTTP 402` or `403` | no X credits, or the app lacks access | check your X developer account |
| `[news:x] HTTP 429` | too many X searches | it waits automatically; raise `X_POLL_S` if it keeps happening |
| `[news:x] daily budget ... reached` | the daily post cap was hit | it resumes at midnight UTC; raise the cap or follow fewer accounts |
| `[news:...] HTTP 403` on a feed | the site blocks automated readers | remove that feed |
| `[coinbase] sequence gap ... resubscribing` | a market message went missing | nothing; it rebuilds the book automatically |
| no news for a long time | normal; old items are ignored and most sources post a few times an hour | test with `NEWS_MANUAL=1` |
| `-` in the report for long horizons | the run stopped before those horizons were reached | run longer |

## Changing things safely

**Adding an exchange:** see [feed.md](feed.md#adding-an-exchange).

**Adding a market measurement:** see [market.md](market.md#adding-a-measurement).

**Adding a news source:** see [news.md](news.md#adding-a-source). Only use official APIs and feeds
that allow automated reading.

**Adding stocks or other assets:** any US stock a source tags works automatically. Other
cryptocurrencies need a price source first (in `src/market/prices.ts`), plus a size scale for
their news questions in `src/news/questions.ts`.

**Changing Jev's questions:** market-data questions live in `DIRECTIONS` in `src/model/jev.ts`;
news questions in `src/news/questions.ts`. Old result files keep the old questions, so only
compare runs that used the same ones.

### Changing record formats

Records have no version number. If you change their fields in a way old files won't match,
add a version field to new records and teach the reports to read both.

**Before spending real requests on a change:**

1. `npm run typecheck`.
2. `JEV_PROVIDER=mock RUN_MINUTES=3 WARMUP_S=30 npm run live`, then `npm run analyze` on the
   output. The random answers must score about zero; anything else means the report is peeking
   at future prices.
3. For news changes: `NEWS_MANUAL=1 JEV_PROVIDER=mock npm run news` and type a few headlines.
