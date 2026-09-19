# Live market data

Code: `src/feed/`.

## What it does

The feed code connects to market data services and turns their messages into one standard
format (`MarketEvent`). The rest of the pipeline only ever sees that standard format.

**Why a standard format?** Every service describes the same things differently. Handling those
differences in one place means the rest of the code never has to care which exchange the data
came from, and adding a new exchange only touches this folder.

There are three kinds of standard event:

- **book**: a change to the order book (a price level's size went up, down, or to zero). A
  "snapshot" replaces the whole book at once.
- **trade**: a trade happened, with the side of the trader who made it happen (the buyer or
  seller who accepted a waiting offer).
- **reset**: data may have been lost (for example the connection dropped), so the book must be
  rebuilt from scratch.

Every event is stamped with the moment it arrived on our machine. That arrival time is the clock
the whole pipeline runs on ([architecture.md](architecture.md#1-one-clock-when-we-received-something)).

## Bitcoin from Coinbase (`coinbase.ts`)

We connect to Coinbase's free public WebSocket, which needs no account, and listen to three
channels:

- **level2**: the full order book. It starts with a snapshot of about 40,000 price levels, then
  sends changes.
- **market_trades**: every trade.
- **heartbeats**: small regular messages that keep the connection alive when the market is quiet.

**Why Coinbase?** It was the fastest of the free Bitcoin feeds we tested from the US (about 31 ms
to reach us, versus 53 to 89 ms for others), it's a US exchange, and it sends the complete order
book.

Things worth knowing:

- **Coinbase labels trades by the waiting side, not the side that made the trade happen.** We
  checked this against the live order book and flip it, because our measurements need the side
  that made the trade happen. If you add another exchange, check this the same way; getting it
  backwards silently turns every "buying pressure" number upside down.
- **If a message goes missing,** Coinbase's numbering skips a number. The feed then emits a reset,
  reconnects, and rebuilds the book from a fresh snapshot. That's simpler and safer than trying
  to patch the gap.
- **Reconnecting** starts after half a second and waits longer after each failure, up to 10
  seconds.
- **Coinbase holds updates for about 47 ms (book) to 85 ms (trades) before sending them.** That
  delay is on their side, so getting closer to their servers can't remove it.

## Stock prices from Alpaca (`alpaca.ts`, `alpaca-stocks.ts`)

Alpaca provides US stock prices and news. `alpaca.ts` handles the connection for both: signing
in, reconnecting after drops (waiting longer each time, up to 30 seconds), and signing back up
for whatever we were following. Other code never has to think about the connection.

`alpaca-stocks.ts` keeps each stock's latest bid and ask. On the free plan it can follow at most
30 stocks at a time, from one exchange (IEX). So stocks are switched on when news about them
arrives and switched off when they're no longer needed. The details are in
[news.md](news.md#prices).

Stock prices here are just the best bid and ask, not a full order book. Free IEX prices are
reliable for big, heavily traded stocks during regular hours, but can be thin for small companies
and very wide outside trading hours.

## Adding an exchange

1. Turn its messages into standard events, stamping the arrival time.
2. Emit a reset whenever data might have been lost.
3. Check which side its trade labels mean, against its order book.
4. Check the order book: after a few minutes, compare it with a fresh snapshot. The best bid and
   ask must match, and the bid must never be at or above the ask. (Don't compare against an
   exchange's "ticker" channel: Coinbase's only updates on trades, so it lags the book.)
5. Measure its delays before assuming it's faster.
