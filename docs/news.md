# The news path

Code: `src/news/`, `src/news-live.ts`, `src/analyze-news.ts`. Run it with `npm run news`.

## What it does

It collects news as it's published, works out which assets each item is about (Bitcoin, a US
stock, or the market as a whole), asks Jev what the news means for each of them, and records
what the prices did over the next 30 minutes.

**Why a news path at all?** Over a few seconds, prices barely move, so trading fees eat any
edge. News can move prices a lot, and judging news takes understanding language, which is
what Jev is good at.

**Why stocks as well as Bitcoin?** Company news clearly belongs to one company, there's a lot of
it every trading day, and stocks often react strongly to their own news. That makes it easier to
learn whether Jev's judgments are any good.

## Step by step

1. A source delivers a news item. It's saved right away to `data/news/items-<time>.jsonl`.
2. The pipeline decides which assets the item is about.
3. It makes sure it has live prices for those assets.
4. It builds what Jev sees: the headline, a summary, how old the item is, and what each asset's
   price has been doing.
5. It asks Jev all its questions in one call.
6. Thirty minutes later it writes one record per asset, with the prices at 10 seconds, 30
   seconds, 1 minute, 5 minutes, 15 minutes, and 30 minutes after the answer.

## Sources

| Source | How it arrives | How we know the asset |
|---|---|---|
| Public news feeds (`rss.ts`): Federal Reserve, CFTC, Coinbase status page, CoinDesk, Cointelegraph | checked every 30 seconds | each feed has fixed assets in the settings |
| Benzinga newswire through Alpaca (`alpaca.ts`) | pushed to us the moment it's published | Benzinga tags stories with tickers |
| SEC 8-K filings (`edgar.ts`) | checked every 30 seconds | the SEC's own company-to-ticker list |
| Official X accounts (`x.ts`) | checked every 30 seconds through X's official API | `$TICKER` cashtags in the post |
| Typed headlines (`manual.ts`) | typed into the terminal, for testing | `$AAPL` or `$BTC` in the text |

**Why several sources?** Each covers different news. Newswires cover companies and markets,
the SEC covers official company filings, and agencies post their own announcements. Every
source hands the rest of the pipeline the same kind of news item, so adding or removing one
doesn't affect anything else.

**Why we're polite to websites.** The feed reader asks each site only for what changed, spaces
out its checks, backs off when a site has trouble, and skips feeds that block automated readers.
It also ignores everything already in a feed when it starts, so a restart doesn't treat old
stories as new.

**Benzinga** comes with the free Alpaca account and is our fastest source, because stories are
pushed to us instead of us checking on a timer.

**SEC filings** tell us *what kind* of event a company reported (for example "entered a material
agreement"), not the details. So Jev can judge whether it matters, but rarely which way. Reading
the attached press release would be a good next improvement. SEC feeds need your name and email
in `NEWS_USER_AGENT`; the SEC asks automated readers to identify themselves.

**X** posts come from a short list of official accounts you choose (`X_ACCOUNTS`). The defaults
are the Federal Reserve, SEC, CFTC, Treasury, Bureau of Labor Statistics, and Coinbase. X charges
per post read, so the reader only asks for new posts, skips retweets and replies, and stops for
the day after a budget you set (`X_MAX_POSTS_PER_DAY`, default 500 posts, about $2.50 at most).

## Which assets an item is about

- If the source tagged it, we use those tags (up to 3; stories with many tags are usually
  roundups).
- If it has no tags, it's treated as general market news: the SPY fund (standing in for the US
  stock market) and Bitcoin.
- If its tags are all things we can't price, it's skipped.

**Why trust the source's tags?** The source knows best what its story is about. Guessing tickers
from the text would add mistakes.

## Prices

Bitcoin prices come from Coinbase, which is always connected. Stock prices come from Alpaca.

We use Alpaca's **free plan**, which gives live prices for up to 30 stocks at a time from one
exchange (IEX). So a stock is switched on only when news about it arrives, and switched off
once its 30-minute check is done. When a stock is switched on, we grab its latest price right
away so there's a starting point.

- **Over the 30-stock limit,** extra stocks can't be watched. Their records say `tracked: false`,
  and their later prices are left unknown rather than shown as unchanged.
- **Outside regular trading hours,** free stock prices can be far apart: on a Saturday, AAPL's bid
  and ask were 0.33% apart and SPY's 6%. A midpoint of prices that far apart isn't a real price.
  So Jev is shown each stock's spread, and the report ignores stock records whose spread was
  wider than 0.5% (`MAX_SPREAD_BPS`).

## What Jev is asked

For each asset:

- **Relevant?** Could this plausibly move the price within the next hour?
- **Direction?** Bullish, bearish, or neutral.
- **How big?** Four levels, from negligible to large. Stocks get a wider scale than Bitcoin,
  because they usually move more on their own news.

And once per item: **Is this new information**, or a recap of something already known?

**Why one call per item?** Jev answers all its questions at the same time, so asking about two
assets takes no longer than one. It only costs a little more text.

**Why show the price's recent moves?** So Jev can judge whether the news already seems priced in.

The number used as the directional signal is: chance it's relevant × (chance it's bullish −
chance it's bearish). That keeps irrelevant items near zero even when they sound dramatic.

### Checked with the real model

On test headlines we typed in, Jev rated a surprise interest-rate cut as relevant and bullish for
Bitcoin, an exchange halting withdrawals as relevant and bearish, and a bakery winning an award as
irrelevant. A made-up AAPL guidance raise came back bullish for AAPL, and a made-up hawkish
central bank statement came back bearish for both SPY and Bitcoin. Each answer took 0.3 to 0.6
seconds. This shows the questions are understood as intended; it doesn't show the answers make
money. Those test outputs are kept in `data/test/`, away from real data.

## When there's too much news

If Jev's rate limit is hit, the item waits at the front of the line and is retried a little
later. Items still waiting after 5 minutes are dropped and counted.

**Why wait instead of dropping right away?** Each news item is a data point, and an answer that's
a minute late is still useful when we measure what happens over 30 minutes.

On the free gateway tier (about 5 Jev calls every 5 minutes), the feeds, SEC, and X are quiet
enough to keep up. Benzinga publishes much more than that during market hours, so most of its
stories would wait and then be dropped. Paid gateway credits remove that limit.

## What's recorded

Each record (`NewsRecord` in `engine.ts`) holds the news item; the asset and, for stocks, the
trading session when the news arrived; whether prices kept coming in; the stock's spread; how long
each step took; exactly what Jev saw; Jev's answers; and the prices when the news was published,
when we got it, when Jev answered, and at each check afterwards.

## Adding a source

1. Turn the new source's items into the standard news item, stamped with the time they arrived.
2. Tag the assets if the source knows them; leave the tags empty for general news.
3. Don't send items that were already published before startup.
4. Add it to `src/news-live.ts`, switched on by `NEWS_SOURCES`.

Use only official APIs and feeds that allow automated reading, and only public information.
