// Live US stock quotes from Alpaca, subscribed on demand.
//
// The free plan streams one exchange (IEX) for at most 30 symbols at a time, so symbols are
// watched only while a decision needs them (until its longest horizon has passed) and then
// unsubscribed. A REST snapshot gives a starting price for symbols not yet streaming.

import { alpacaGet, AlpacaStream, type AlpacaCreds } from './alpaca.ts';
import { QuoteBook } from '../market/quotes.ts';

type LatestQuotes = { quotes?: Record<string, { bp: number; ap: number }> };

export class AlpacaStocks {
  readonly book: QuoteBook;
  readonly stats = { watching: 0, rejected: 0, snapshots: 0, snapshotErrors: 0 };
  private readonly watching = new Map<string, number>(); // symbol -> keep until (local ms)
  private readonly stream: AlpacaStream;
  private readonly creds: AlpacaCreds;
  private readonly feed: string;
  private readonly maxSymbols: number;
  private readonly log: (s: string) => void;

  constructor(creds: AlpacaCreds, feed: string, maxSymbols: number, retentionMs: number, log: (s: string) => void) {
    this.creds = creds;
    this.feed = feed;
    this.maxSymbols = maxSymbols;
    this.log = log;
    this.book = new QuoteBook(retentionMs);
    this.stream = new AlpacaStream(
      `wss://stream.data.alpaca.markets/v2/${feed}`,
      creds,
      (m, recvTs) => {
        if (m.T === 'q') this.book.update(m.S as string, recvTs, m.bp as number, m.ap as number);
      },
      () => (this.watching.size > 0 ? { quotes: [...this.watching.keys()] } : undefined),
      log,
    );
  }

  /**
   * Stream these symbols until `untilTs`. Symbols with no price yet get a REST snapshot placed
   * at `seedTs`. Returns the symbols that are streaming; the rest are over the plan's limit.
   */
  async watch(symbols: string[], untilTs: number, seedTs: number): Promise<Set<string>> {
    const added: string[] = [];
    for (const s of symbols) {
      const until = this.watching.get(s);
      if (until !== undefined) this.watching.set(s, Math.max(until, untilTs));
      else if (this.watching.size < this.maxSymbols) {
        this.watching.set(s, untilTs);
        added.push(s);
      } else this.stats.rejected++;
    }
    if (added.length > 0) this.stream.send({ action: 'subscribe', quotes: added });
    this.stats.watching = this.watching.size;
    const unknown = symbols.filter(s => Number.isNaN(this.book.mid(s)));
    if (unknown.length > 0) await this.snapshot(unknown, seedTs);
    return new Set(symbols.filter(s => this.watching.has(s)));
  }

  /** Unsubscribe symbols no decision needs any more, and forget their (soon stale) history. */
  sweep(now: number) {
    const done = [...this.watching].filter(([, until]) => until < now).map(([s]) => s);
    if (done.length === 0) return;
    for (const s of done) {
      this.watching.delete(s);
      this.book.drop(s);
    }
    this.stream.send({ action: 'unsubscribe', quotes: done });
    this.stats.watching = this.watching.size;
  }

  close() {
    this.stream.close();
  }

  private async snapshot(symbols: string[], seedTs: number) {
    try {
      const body = await alpacaGet<LatestQuotes>(this.creds, `/v2/stocks/quotes/latest?symbols=${symbols.map(encodeURIComponent).join(',')}&feed=${this.feed}`);
      for (const [symbol, q] of Object.entries(body.quotes ?? {})) this.book.seed(symbol, seedTs, q.bp, q.ap);
      this.stats.snapshots++;
    } catch (error) {
      this.stats.snapshotErrors++;
      this.log(`[alpaca] snapshot failed for ${symbols.join(',')}: ${(error as Error).message}`);
    }
  }
}
