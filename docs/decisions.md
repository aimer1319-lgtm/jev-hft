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
news services stamp on it. For a news feed, "arrived" means the whole feed had downloaded.

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
about 260 ms waiting for Jev), so a faster language or more threads wouldn't change anything
noticeable. Running the source directly means what's in the repo is exactly what runs.

## D6. Call Jev through Vercel's AI SDK

**Chosen:** the pipeline calls Jev through the AI SDK. Only the speed benchmark makes requests by
hand.

**Why:** the SDK checks Jev's answers for us and lets us swap between the gateway, TypeSafe's
direct API, and the mock model without touching anything else. The benchmark is the exception
because it needs to time each step of a request, which the SDK doesn't allow.

## D7. Use the gateway by default; going direct is one setting away

**Chosen:** requests go through Vercel AI Gateway unless `JEV_PROVIDER=typesafe` is set.

**Why:** the project was set up around the gateway: one key, one bill. But more than half of each
round trip is the route rather than the model, and TypeSafe's own servers answer us in about 40 ms
against the gateway's 95 ms at best, so the direct route is the biggest speed-up available.
**Rethink** once a TypeSafe key is available: compare the two and consider going direct.

## D8. `ask()` never retries; each engine decides for itself

**Chosen:** the function that calls Jev makes one attempt. The market-data engine never asks
again: requests taking over 2 seconds are abandoned and the next snapshot is used instead. The
news engine tries a failed item again, up to three calls in all.

**Why:** a retried market answer arrives late and describes a market that has already moved on,
and a fresh snapshot is always available. A news item is different: there's only one of it, its
answer is still useful a few seconds late, and we've seen the gateway time out on an otherwise
healthy day. Only passing failures are retried (timeouts, network trouble, server errors); a
rejected key would fail the same way again.

## D9. Ask several questions in each call

**Chosen:** the market-data path asks about 2, 10, and 60 seconds ahead in one call. The news
path asks about every asset an item concerns in one call.

**Why:** Jev answers questions at the same time, so extra questions cost almost no time. The text
is also counted once however many questions are asked about it, so it's cheaper. More horizons
also help us find which one, if any, Jev is good at.

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
to compute?" Without them, results can't be judged. The report goes one step further and shows
what's left of Jev's score once the rules are accounted for, because Jev reads the same numbers
the rules are built from and could simply be repeating them. On 31 minutes of recorded data that
is what we found: Jev scored about half as well as plain book imbalance, and nothing of its score
was left once the rules were accounted for ([model.md](model.md#what-jev-has-shown-on-market-data-so-far)).

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

**Why:** a millisecond timestamp would make every text different from the last without adding
anything useful, and Jev's answers shift a little whenever its input changes.

## D18. Settings come from environment variables

**Chosen:** every setting is read in `src/config.ts` from environment variables, with defaults,
and checked at startup.

**Why:** it works the same in a terminal, a service, or another machine, with no config file
format to learn. Checking at startup means a typo stops the program with a clear message instead
of quietly doing something else. **Rethink** if settings get complicated enough to need a proper
config file.

## D19. Save everything as JSON Lines

**Chosen:** one JSON record per line; saved market data is also compressed.

**Why:** these files can be appended to as things happen, survive a crash up to the last line,
and open easily in other tools. Only market data is compressed, because it's large; decision files
are left readable.

## D20. Read public news feeds politely, and as often as that allows

**Chosen:** the feed reader asks sites only for changes, adds a little random timing, backs off
after errors, skips feeds that block automated readers, and ignores whatever was already in a
feed at startup. A feed that can answer "nothing changed" with an empty reply is checked every
10 seconds; one that sends everything each time, every 30. The SEC's filing list is checked
every 10 seconds regardless.

**Why:** free public feeds are enough to test whether Jev can tell which news matters, and being
a good citizen keeps them available. An empty "nothing changed" reply costs a site almost
nothing, so asking often is fair, and it cuts the average wait to notice news from 15 seconds to
5. The SEC allows up to 10 requests a second, and filings move prices within minutes. Ignoring
the startup backlog stops a restart from treating old stories as new.

## D21. News waits for Jev; market snapshots don't

**Chosen:** when Jev's rate limit is hit, a news item waits (up to 5 minutes) and is retried. A
refused market-data question is simply dropped.

**Why:** market snapshots are interchangeable, and the next one is fresher anyway. News items are
rare, each one is a data point, and a slightly late answer still tells us something over a
30-minute window.

## D22. News and market data run as separate programs

**Chosen:** `npm run news` and `npm run live` are separate programs.

**Why:** they can be started and stopped independently, and on an account without credits they
don't compete for the few Jev calls allowed.

## D23. Count separate pieces of evidence, not decisions

**Chosen:** the reports' confidence scores count only decisions that are at least one full
horizon apart, walking through them in time order. For news, that's done per asset.

**Why:** decisions a fraction of a second apart look at nearly the same future. Counting each one
separately made early results look far more certain than they were. Dividing the run's length by
the horizon (the first fix) was still too generous whenever decisions came in bursts, which is
what a rate limit produces: ten decisions in two bursts are two pieces of evidence, not thirty.

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

## D27. Switch stock prices on only when needed (except SPY)

**Chosen:** a stock's live prices are switched on when news about it arrives and off after its
last check. When it's switched on, its latest price, last close, and last 40 minutes of prices
are fetched at once. SPY, which stands for the whole market, stays on permanently. We stay on
Alpaca's free plan.

**Why:** the free plan allows only 30 stocks at a time, which is enough if we watch only the
stocks in the news. Fetching recent prices up front means Jev can be told what a stock has been
doing from the very first item about it. SPY is needed for every general news item, so keeping
it on costs one slot and gives it continuous history; it also gives the connection something to
confirm every 30 seconds, so a connection that died while idle is noticed before it's needed.

## D28. Let the source decide which assets a news item is about

**Chosen:** we use the tags each source provides. Items without tags count as general market news
(SPY and Bitcoin). Items tagged only with things we can't price are skipped. At most 3 assets per
item. One exception: in cashtags typed by people (X posts, typed headlines), well-known crypto
symbols other than Bitcoin count as "can't price".

**Why:** the source knows best what its story is about; guessing tickers from text would add
mistakes. The cap stops "10 stocks to watch" roundups from using up our limits. The exception
exists because `$ETH` and `$SOL` are also real stock tickers, and a person writing `$SOL` almost
never means the stock.

## D29. Secrets live in a gitignored `.env`, loaded by Node

**Chosen:** all API keys, including the gateway key, are kept in `.env`, which is private (only
readable by you) and never committed. Every npm script loads it.

**Why:** the project then runs the same from any terminal, as a background service, or on another
machine such as a Raspberry Pi. Settings already in your shell take priority, so a server can
provide its own.

## D30. A stock's price only counts when its bid and ask are close together

**Chosen:** Jev sees each stock's bid/ask spread. The engine doesn't ask about a stock whose
spread is over 0.5%. The report counts a price move only if the spread was under 0.5% both when
Jev answered and at the later moment being checked.

**Why:** outside trading hours, free stock prices can be several percent apart. The midpoint of
prices that far apart isn't a real price. Checking both ends matters because a story at 3:50 pm
has its 30-minute check after the close, when a thin quote's midpoint can sit far from the last
real price and look like a big move that never happened.

## D31. Read X with one search over a short list of official accounts, on a budget

**Chosen:** every 10 seconds, one search covers all chosen accounts. It reads only new posts,
skips retweets and replies, stops for the day at a set number of posts, and never asks for
account profiles alongside posts. The accounts' ids are looked up once and saved.

**Why:** X charges for each post it returns and twice as much for each profile, but nothing for a
search that finds nothing. So searching often is free and cuts the wait to notice a post, while
attaching profiles to every search could cost more than the posts. Official accounts are where
important announcements appear first. **Rethink** if speed from X becomes more important than
cost; X's real-time stream would be faster.

## D32. On a Raspberry Pi, run as a systemd service

**Chosen:** `deploy/pi/setup.sh` installs the pipeline as a systemd service (`jev-hft@news-live`,
or `record` / `live`). It starts at boot after the clock syncs, restarts after crashes and once a
week, and may only write to the project's `data/` folder.

**Why:** systemd comes with Raspberry Pi OS, so nothing extra is needed to keep the pipeline
running unattended, and its logs are kept in the system journal. Waiting for the clock matters
because every recorded time depends on it. Stopping sends the same signal as Ctrl-C, so pending
records are saved before it exits.

## D33. Keep Jev's connection open

**Chosen:** calls to Jev use their own connection settings (idle connections kept 25 seconds),
and a tiny request every 20 seconds keeps one connection open at all times.

**Why:** Node closes a connection after 4 idle seconds, and opening a new encrypted one costs
about 100 ms. News calls are minutes apart, so every news decision was paying that. With this,
news decisions 25 seconds apart took 255 to 300 ms instead of 460 to 550. The tiny request
carries no key and reaches no model, so it costs nothing. It only affects Jev's connection.

## D34. Only ask what can be measured

**Chosen:** before calling Jev about a news item, the engine leaves out stocks whose market is
closed, assets without a usable price right now, and near-identical repeats of a recent headline.
If nothing is left, no call is made. The item is still saved.

**Why:** an answer that can never be checked against a price move teaches us nothing, still costs
a call, and on an account without credits uses up one of very few. Asking about the same event
several times also made it count several times in the results. `NEWS_ONLY_TRADABLE=0` switches
the first two filters off for testing.

## D35. Show Jev what has already been reported

**Chosen:** the engine remembers the last 6 hours of headlines. Each item is shown with up to 5
earlier headlines about the same asset, and the "is this new?" question says those are already
known. An item the model never answered about (skipped, or every call failed) still counts as
known, but doesn't make a later report of the same story count as a repeat.

**Why:** Jev can't know whether a headline is news or a follow-up unless it's shown what came
before. With the real model, the same headline scored 0.73 for "new" on its own, 0.33 after two
earlier reports of the same event, and 0.83 after an unrelated one, while its other answers
stayed the same. "Related" is judged by shared tickers and shared words, which is crude but needs
no extra model call.

## D36. Name things in full for Jev

**Chosen:** questions say "Apple Inc. (AAPL)", not "AAPL stock", using the SEC's public company
list, and "the S&P 500 index (SPY ETF)" for SPY. Each source is described in words ("Federal
Reserve press releases (official)") instead of by its short internal name. SEC filing entries are
restated as plain sentences.

**Why:** Jev reads language. A bare ticker may mean nothing to it for a small company, `fed` says
less than "Federal Reserve press releases", and the SEC feed's own wording is written for filing
clerks. The company list loads in the background and is retried if it fails; until it arrives,
bare tickers are used.

## D37. What counts as "flat" follows the market's volatility

**Chosen:** in the market-data questions, "flat" means a move smaller than two typical moves for
that horizon at the current volatility, rounded to 0.1 bp. The thresholds used are saved with
each decision, and the report judges each answer against its own.

**Why:** a fixed threshold suits one kind of market: in a busy one nearly everything counts as up
or down, in a dead one nothing does. For the multiplier we tested half, one, and two typical
moves, and the old fixed thresholds, on the same recorded snapshots. They predicted equally well.
The narrower the band, the more of Jev's answers were pinned at the extremes (23% of 60-second
answers at half a typical move, 1% at two), and an answer that's always extreme ranks nothing. So
the default is the widest one tested. We had expected the opposite, which is why it was tested.
**Rethink** with data from a busier market: the report's calibration section shows Jev's average
answer next to what really happened.

## D38. Ask about the market once a second, not back to back

**Chosen:** the live market-data loop waits at least a second between questions by default.

**Why:** back to back it makes about 2.7 decisions a second, but decisions that close together
look at nearly the same few seconds, and the report counts stretches of time, not decisions
(D23). So most of that spending buys the same information again. Once a second costs about $3 a
day instead of $8, and every decision is just as fresh, because each uses a snapshot taken when
it's sent.

## D39. Pay for each backtest answer once

**Chosen:** backtest answers are saved on disk, filed under exactly what Jev was shown. A backtest
also says what it's about to cost before it starts.

**Why:** the delay we pretend and the way results are scored don't change what Jev was asked, so
trying another delay, fixing the report, or finishing an interrupted run shouldn't cost anything.
The practice model's random answers are never kept.

## D40. During an outage the price is unknown, not unchanged

**Chosen:** from the last good message before a connection problem until data is flowing again,
"what was the price at time t?" answers "unknown", for Bitcoin and for stocks.

**Why:** the old behaviour reported the last price from before the outage, so any check that
landed inside one was recorded as "the price didn't move". That's a made-up number, and the
reports already know to leave unknowns out.

## D41. Every connection has a way to notice it has died

**Chosen:** Coinbase's connection is replaced after 10 seconds of silence (it normally sends a
message every second). Alpaca's connections re-send their current subscriptions every 30 seconds
and are replaced if nothing at all comes back within 10 seconds.

**Why:** a connection can die without the computer noticing, especially on Wi-Fi and home
routers. The program would then look healthy while seeing nothing, possibly for hours. Alpaca's
streams are legitimately silent at night and on weekends, so silence alone proves nothing there;
re-sending a subscription is a valid message that always gets a reply.

## D42. Records carry a format version

**Chosen:** every record has `v: 2`. Files from before versions existed have none, and the reports
read both.

**Why:** records gained fields (cost, TypeSafe's share of the time, confidence, thresholds, later
spreads). New fields that old files simply lack are harmless, but the next change might not be,
and a version number is what lets a report tell old from new.

## D43. Tests for the rules that results depend on

**Chosen:** `npm test` runs about 70 tests with Node's built-in runner: no extra packages, no
network, about a second.

**Why:** a broken measurement still produces plausible numbers, so these rules are easy to break
without noticing: no price from the future, unknown is never zero, market hours across daylight
saving, no call when the outcome can't be measured. The news engine takes its clock as a setting
so that time-dependent rules can be tested on any day.
