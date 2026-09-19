# Design decisions

A short record of the main choices behind this project: what we chose and why, in plain
words. Where it helps, each entry also says when the choice should be rethought.

---

## D1. Paper trading only

**Chosen:** the pipeline records decisions and what prices did afterwards. It never places trades.

**Why:** we don't yet know whether Jev's judgments make money. Real trading adds accounts, order
handling, and risk controls that only make sense once the reports show a real edge. If that day
comes, trading should be added as a separate layer on top, not mixed into the existing code.

## D2. Coinbase for Bitcoin data

**Chosen:** Coinbase's free public feed: full order book and trades, no account needed.

**Why:** it was the fastest free Bitcoin feed we tested from the US, it's a US exchange, and it
sends the complete order book with numbered messages, so we can tell when one goes missing.

## D3. One clock: when data arrived on our machine

**Chosen:** all timing uses the moment data arrived on our machine, not the times exchanges or
news services stamp on it.

**Why:** what matters is when *we* knew something. Outside timestamps come from other computers
and don't agree with each other. One local clock also makes replays exact.

## D4. Market state changes only when data arrives

**Chosen:** the market state is only updated by incoming events; it never uses timers or reads
the clock.

**Why:** replaying recorded data then gives exactly the same results as the live run, which is
what makes backtests trustworthy.

## D5. One simple program per path, in TypeScript with no build step

**Chosen:** each path is a single Node.js program. Node 24 runs the TypeScript files directly.

**Why:** our own processing takes a tiny fraction of the time (well under a millisecond, against
about 350 ms waiting for Jev), so a faster language or more threads wouldn't change anything
noticeable. Running the source directly means what's in the repo is exactly what runs.

## D6. Call Jev through Vercel's AI SDK

**Chosen:** the pipeline calls Jev through the AI SDK. Only the speed benchmark makes requests by
hand.

**Why:** the SDK checks Jev's answers for us and lets us swap between the gateway, TypeSafe's
direct API, and the mock model without touching anything else. The benchmark is the exception
because it needs to time each step of a request, which the SDK doesn't allow.

## D7. Use the gateway by default; going direct is one setting away

**Chosen:** requests go through Vercel AI Gateway unless `JEV_PROVIDER=typesafe` is set.

**Why:** the project was set up around the gateway: one key, one bill. But most of each round
trip is spent in the gateway itself, so the direct route is the biggest speed-up available.
**Rethink** once a TypeSafe key is available: compare the two and consider going direct.

## D8. Never retry a question to Jev automatically

**Chosen:** if a request fails or is refused, it isn't automatically sent again. Requests taking
over 2 seconds are abandoned.

**Why:** a retried answer arrives late and describes a market that has already moved on. Each
engine decides for itself what to do next.

## D9. Ask several questions in each call

**Chosen:** the market-data path asks about 2, 10, and 60 seconds ahead in one call. The news
path asks about every asset an item concerns in one call.

**Why:** Jev answers questions at the same time, so extra questions cost almost no time. More
horizons also help us find which one, if any, Jev is good at.

## D10. Send Jev summaries, not raw data

**Chosen:** Jev reads about seven labeled lines of market measurements, with notes on which ones
are unusual right now.

**Why:** sending more text didn't make Jev any slower, but it cost up to 15 times more. A few
well-chosen, labeled numbers say more than a long list of raw prices.

## D11. Write records once, when they're complete

**Chosen:** a decision is written to disk only after its last price check (60 seconds for market
data, 30 minutes for news).

**Why:** every line in a results file is complete, so reports stay simple. The cost: if the
program crashes (as opposed to being stopped normally), unfinished records are lost. Raw news
items are saved immediately, so those survive either way.

## D12. Judge every decision from two moments

**Chosen:** each record has the later prices measured both from when the snapshot was taken and
from when Jev's answer arrived.

**Why:** the first shows whether Jev saw something real; the second shows whether anyone could
have acted on it in time. Confusing the two makes slow strategies look profitable on paper.

## D13. Keep simple rules next to every Jev answer

**Chosen:** every market-data record also stores four simple signals (book imbalance at two
depths, recent order flow, recent momentum) from the same snapshot.

**Why:** the question isn't just "is Jev right?" but "is Jev better than rules that take no time
to compute?" Without them, results can't be judged.

## D14. Backtests ask about many moments at once, and pretend the answers came late

**Chosen:** backtests ask Jev about many recorded moments in parallel, then score each answer as
if it had arrived a set delay later.

**Why:** whether Jev sees anything doesn't depend on speed, and asking about past moments in
parallel gives thousands of answers quickly. The delay is then applied honestly when scoring.

## D15. Keep the full order book, sorted with the best price last

**Chosen:** the book keeps every price level, in sorted lists with the best price at the end.

**Why:** almost all changes happen near the best price, and changes at the end of a list are
quick. This made each update about six times faster. The whole book is kept because distant
price levels become important when the market moves.

## D16. Leave the "microprice" out of Jev's text

**Chosen:** the microprice is calculated but not shown to Jev.

**Why:** Bitcoin's bid and ask on Coinbase are almost always one cent apart, and then the
microprice adds nothing that book imbalance doesn't already say. **Rethink** for markets where
the bid and ask are usually further apart.

## D17. Show the time to the minute only

**Chosen:** Jev's text shows times like `05:56 UTC`, not milliseconds.

**Why:** Jev's answers shift a little whenever its input changes. A millisecond timestamp would
change every time without adding anything useful.

## D18. Settings come from environment variables

**Chosen:** every setting is read in `src/config.ts` from environment variables, with defaults.

**Why:** it works the same in a terminal, a service, or another machine, with no config file
format to learn. **Rethink** if settings get complicated enough to need a proper config file.

## D19. Save everything as JSON Lines

**Chosen:** one JSON record per line; saved market data is also compressed.

**Why:** these files can be appended to as things happen, survive a crash up to the last line,
and open easily in other tools. Only market data is compressed, because it's large; decision files
are left readable.

## D20. Read public news feeds politely

**Chosen:** the feed reader asks sites only for changes, checks every 30 seconds with a little
random timing, backs off after errors, skips feeds that block automated readers, and ignores
whatever was already in a feed at startup.

**Why:** free public feeds are enough to test whether Jev can tell which news matters, and being
a good citizen keeps them available. Ignoring the startup backlog stops a restart from treating
old stories as new.

## D21. News waits for Jev; market snapshots don't

**Chosen:** when Jev's rate limit is hit, a news item waits (up to 5 minutes) and is retried. A
refused market-data question is simply dropped.

**Why:** market snapshots are interchangeable, and the next one is fresher anyway. News items are
rare, each one is a data point, and a slightly late answer still tells us something over a
30-minute window.

## D22. News and market data run as separate programs

**Chosen:** `npm run news` and `npm run live` are separate programs.

**Why:** they can be started and stopped independently, and they don't compete for Jev's rate
limit. The news feeds, SEC, and X are quiet enough to run on the gateway's free tier; the market
data path and the busy Benzinga stream need paid credits to run at full speed.

## D23. Count only truly separate stretches of time when judging confidence

**Chosen:** the report's confidence score counts separate stretches of time, not individual
decisions.

**Why:** decisions a fraction of a second apart look at nearly the same future. Counting each one
separately made early results look far more certain than they were.

## D24. Ship a practice model

**Chosen:** `JEV_PROVIDER=mock` gives random answers after a realistic delay.

**Why:** it lets anyone run the whole pipeline for free, and it tests the reports: random answers
must score about zero. They did, which shows the reports don't accidentally look at future prices.

## D25. External data only through official access

**Chosen:** outside data comes only from official APIs and feeds that allow automated reading:
public news feeds, the SEC, Alpaca, and X's API.

**Why:** official sources are stable, have clear limits and prices, and there's no question about
whether we're allowed to use what we collect.

## D26. One Jev call per news item, covering all its assets

**Chosen:** a news item that concerns several assets gets one call with questions for each asset,
plus one shared "is this new?" question.

**Why:** Jev answers questions at the same time, so a second asset costs a little extra text but
no extra time and no extra rate-limit use. Whether an item is new doesn't depend on the asset, so
it's asked once.

## D27. Switch stock prices on only when needed

**Chosen:** a stock's live prices are switched on when news about it arrives and off after its
last check, with its latest price fetched immediately so there's a starting point. We stay on
Alpaca's free plan.

**Why:** the free plan allows only 30 stocks at a time, which is enough if we watch only the stocks
in the news. When the limit is reached, those records are clearly marked as missing prices rather
than showing a price that stopped updating.

## D28. Let the source decide which assets a news item is about

**Chosen:** we use the tags each source provides. Items without tags count as general market news
(SPY and Bitcoin). Items tagged only with things we can't price are skipped. At most 3 assets per
item.

**Why:** the source knows best what its story is about; guessing tickers from text would add
mistakes. The cap stops "10 stocks to watch" roundups from using up our limits.

## D29. Secrets live in a gitignored `.env`, loaded by Node

**Chosen:** all API keys, including the gateway key, are kept in `.env`, which is private (only
readable by you) and never committed. Every npm script loads it.

**Why:** the project then runs the same from any terminal, as a background service, or on another
machine such as a Raspberry Pi. Settings already in your shell take priority, so a server can
provide its own.

## D30. Show stock spreads to Jev, and ignore wide ones in reports

**Chosen:** Jev sees each stock's bid/ask spread, and the news report ignores stock prices whose
spread is wider than 0.5%.

**Why:** outside trading hours, free stock prices can be several percent apart. The midpoint of
prices that far apart isn't a real price, so Jev should know to distrust it and the report
shouldn't count it.

## D31. Read X with one search over a short list of official accounts, on a budget

**Chosen:** every 30 seconds, one search covers all chosen accounts. It reads only new posts,
skips retweets and replies, and stops for the day at a set number of posts.

**Why:** X charges for every post read, so this keeps costs to cents a day. Official accounts are
where important announcements appear first, and one search per check stays well within X's
limits. **Rethink** if speed from X becomes more important than cost; X's real-time stream would
be faster.

## D32. On a Raspberry Pi, run as a systemd service

**Chosen:** `deploy/pi/setup.sh` installs the pipeline as a systemd service (`jev-hft@news-live`,
or `record` / `live`). It starts at boot after the clock syncs, restarts after crashes and once a
week, and may only write to the project's `data/` folder.

**Why:** systemd comes with Raspberry Pi OS, so nothing extra is needed to keep the pipeline
running unattended, and its logs are kept in the system journal. Waiting for the clock matters
because every recorded time depends on it. Stopping sends the same signal as Ctrl-C, so pending
records are saved before it exits.
