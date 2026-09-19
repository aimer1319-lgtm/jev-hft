// Live US stock quotes from Alpaca, subscribed on demand.
//
// The free plan streams one exchange (IEX) for at most 30 symbols at a time, so symbols are
// watched only while a decision needs them (until its longest horizon has passed) and then
// unsubscribed. When a symbol is first needed, two REST calls (made at the same time) give it
// a starting point: the latest quote, and the last 40 minutes of one-minute bars plus the last
// closing price, so the model can be told what the stock has been doing.
//
// A few symbols can be pinned: followed for as long as the program runs. They are the ones
// needed all the time (SPY, for general market news). Pinning also means the connection always
// has something to confirm, so a connection that died while idle is noticed before it is needed.

import { alpacaGet, AlpacaStream, type AlpacaCreds } from './alpaca.ts';
import { nowMs } from './types.ts';
import { QuoteBook } from '../market/quotes.ts';
import { nyDate, usSession } from '../market/sessions.ts';

type Bar = { t: string; c: number };
type Snapshots = Record<string, { latestQuote?: { bp: number; ap: number }; dailyBar?: Bar; prevDailyBar?: Bar }>;
type Bars = { bars?: Record<string, Bar[]> };

/** How far back minute bars are fetched: the "last 30 minutes" of context, with margin. */
const HISTORY_MS = 40 * 60_000;
/** A symbol over the plan's limit has only a one-off price; forget it after this long. */
const UNSTREAMED_TTL_MS = 2 * 60_000;
/** Pinned symbols are never re-fetched on demand, so their last close is refreshed this often. */
const PINNED_REFRESH_MS = 30 * 60_000;

export class AlpacaStocks {
  readonly book: QuoteBook;
  readonly stats = { watching: 0, rejected: 0, snapshots: 0, snapshotErrors: 0, reconnects: 0 };
  /** symbol -> keep until (local ms), and whether it holds one of the plan's streaming slots. */
  private readonly watching = new Map<string, { until: number; streaming: boolean }>();
  private readonly closes = new Map<string, number>();
  private readonly pinned: string[];
  private pinnedRefreshedAt = -Infinity;
  private up = false;
  private everUp = false;
  private readonly stream: AlpacaStream;
  private readonly creds: AlpacaCreds;
  private readonly feed: string;
  private readonly maxSymbols: number;
  private readonly log: (s: string) => void;

  constructor(creds: AlpacaCreds, feed: string, maxSymbols: number, retentionMs: number, log: (s: string) => void, pinned: string[] = []) {
    this.creds = creds;
    this.feed = feed;
    this.maxSymbols = maxSymbols;
    this.log = log;
    this.pinned = pinned.slice(0, maxSymbols);
    for (const s of this.pinned) this.watching.set(s, { until: Infinity, streaming: true });
    this.stats.watching = this.pinned.length;
    this.book = new QuoteBook(retentionMs);
    this.stream = new AlpacaStream({
      url: `wss://stream.data.alpaca.markets/v2/${feed}`,
      creds,
      onMessage: (m, recvTs) => {
        if (m.T === 'q') this.book.update(m.S as string, recvTs, m.bp as number, m.ap as number);
      },
      subscription: () => {
        const symbols = this.streaming();
        return symbols.length > 0 ? { quotes: symbols } : undefined;
      },
      onDown: lastMessageTs => {
        this.up = false;
        this.book.markGap(lastMessageTs);
      },
      onUp: () => {
        this.up = true;
        if (this.everUp) void this.recover(); // the first connection has nothing to recover
        this.everUp = true;
      },
      log,
    });
  }

  /**
   * Stream these symbols until `untilTs`. Symbols with no price yet get a REST snapshot placed
   * at `seedTs`. Returns the symbols that are streaming; the rest are over the plan's limit.
   */
  async watch(symbols: string[], untilTs: number, seedTs: number): Promise<Set<string>> {
    const added: string[] = [];
    let slots = this.maxSymbols - this.streaming().length;
    for (const s of symbols) {
      const w = this.watching.get(s);
      if (w?.streaming) w.until = Math.max(w.until, untilTs);
      else if (slots > 0) {
        slots--;
        this.watching.set(s, { until: untilTs, streaming: true });
        added.push(s);
      } else {
        this.stats.rejected++;
        this.watching.set(s, { until: nowMs() + UNSTREAMED_TTL_MS, streaming: false });
      }
    }
    if (added.length > 0) this.stream.send({ action: 'subscribe', quotes: added });
    this.stats.watching = this.streaming().length;
    const unknown = symbols.filter(s => Number.isNaN(this.book.mid(s)));
    if (unknown.length > 0) await this.snapshot(unknown, seedTs);
    return new Set(symbols.filter(s => this.watching.get(s)?.streaming));
  }

  /** The last closing price (NaN if unknown): during the regular session, the previous day's. */
  lastClose(symbol: string): number {
    return this.closes.get(symbol) ?? NaN;
  }

  /** Unsubscribe symbols no decision needs any more, and forget their (soon stale) history. */
  sweep(now: number) {
    if (this.pinned.length > 0 && now - this.pinnedRefreshedAt > PINNED_REFRESH_MS) {
      this.pinnedRefreshedAt = now;
      void this.snapshot(this.pinned, now); // in the background: nothing waits for it
    }
    const done = [...this.watching].filter(([, w]) => w.until < now);
    if (done.length === 0) return;
    for (const [s] of done) {
      this.watching.delete(s);
      this.closes.delete(s);
      this.book.drop(s);
    }
    const streamed = done.filter(([, w]) => w.streaming).map(([s]) => s);
    if (streamed.length > 0) this.stream.send({ action: 'unsubscribe', quotes: streamed });
    this.stats.watching = this.streaming().length;
  }

  close() {
    this.stream.close();
  }

  private streaming() {
    return [...this.watching].filter(([, w]) => w.streaming).map(([s]) => s);
  }

  private async snapshot(symbols: string[], seedTs: number) {
    const list = symbols.map(encodeURIComponent).join(',');
    const start = new Date(nowMs() - HISTORY_MS).toISOString();
    const [quotes, bars] = await Promise.allSettled([
      alpacaGet<Snapshots>(this.creds, `/v2/stocks/snapshots?symbols=${list}&feed=${this.feed}`),
      alpacaGet<Bars>(this.creds, `/v2/stocks/bars?symbols=${list}&timeframe=1Min&start=${start}&limit=1000&feed=${this.feed}`),
    ]);
    if (quotes.status === 'fulfilled') {
      const now = nowMs();
      for (const [symbol, s] of Object.entries(quotes.value)) {
        if (s.latestQuote) this.book.seed(symbol, seedTs, s.latestQuote.bp, s.latestQuote.ap);
        // While today's session is still trading, "the last close" is yesterday's.
        const tradingToday = s.dailyBar && nyDate(Date.parse(s.dailyBar.t)) === nyDate(now) && usSession(now) === 'regular';
        const close = tradingToday ? s.prevDailyBar?.c : (s.dailyBar?.c ?? s.prevDailyBar?.c);
        if (close && close > 0) this.closes.set(symbol, close);
      }
      this.stats.snapshots++;
    } else this.failed(symbols, quotes.reason);
    // Bars are context only, so losing them is not worth a warning on every item.
    if (bars.status === 'fulfilled') {
      const now = nowMs();
      for (const [symbol, list] of Object.entries(bars.value.bars ?? {})) {
        // A bar's time is its start; its closing price is known a minute later.
        const points = list.map(b => ({ t: Date.parse(b.t) + 60_000, price: b.c })).filter(p => p.t < Math.min(seedTs, now));
        this.book.seedHistory(symbol, points.sort((a, b) => a.t - b.t));
      }
    }
  }

  /** After a reconnect: refresh every streamed symbol's quote, then trust prices again. */
  private async recover() {
    this.stats.reconnects++;
    const symbols = this.streaming();
    if (symbols.length > 0) {
      try {
        const list = symbols.map(encodeURIComponent).join(',');
        const body = await alpacaGet<Snapshots>(this.creds, `/v2/stocks/snapshots?symbols=${list}&feed=${this.feed}`);
        const now = nowMs();
        for (const [symbol, s] of Object.entries(body)) if (s.latestQuote) this.book.update(symbol, now, s.latestQuote.bp, s.latestQuote.ap);
      } catch (error) {
        this.failed(symbols, error);
      }
    }
    if (this.up) this.book.resume(nowMs()); // unless it dropped again while we were refreshing
  }

  private failed(symbols: string[], error: unknown) {
    this.stats.snapshotErrors++;
    this.log(`[alpaca] snapshot failed for ${symbols.join(',')}: ${(error as Error).message}`);
  }
}
