// "What did this instrument cost at time t?" for every instrument the news path covers,
// whichever feed backs it: Bitcoin from the Coinbase order book, US stocks from Alpaca quotes.

import type { AlpacaStocks } from '../feed/alpaca-stocks.ts';
import type { MarketState } from './state.ts';

export const CRYPTO_SYMBOL = 'BTC-USD';

export interface Prices {
  /**
   * Make these instruments priceable until `untilTs`. Returns the symbols whose prices will keep
   * updating; for the others, forward prices are unknown.
   */
  prepare(symbols: string[], untilTs: number, seedTs: number): Promise<Set<string>>;
  mid(symbol: string): number;
  midAt(symbol: string, t: number): number;
  /** Bid/ask spread now, in basis points. */
  spreadBps(symbol: string): number;
  /** Bid/ask spread of the quote in force at time t (NaN when not tracked over time). */
  spreadAt(symbol: string, t: number): number;
  /** The last closing price, for instruments that have one (NaN otherwise). */
  lastClose(symbol: string): number;
  /** Periodic housekeeping (release subscriptions nobody needs). */
  tick(now: number): void;
}

export class LivePrices implements Prices {
  private readonly market: MarketState;
  private readonly stocks: AlpacaStocks | undefined;

  constructor(market: MarketState, stocks: AlpacaStocks | undefined) {
    this.market = market;
    this.stocks = stocks;
  }

  async prepare(symbols: string[], untilTs: number, seedTs: number): Promise<Set<string>> {
    const tracked = new Set<string>(symbols.filter(s => s === CRYPTO_SYMBOL));
    const equities = symbols.filter(s => s !== CRYPTO_SYMBOL);
    if (equities.length > 0 && this.stocks) for (const s of await this.stocks.watch(equities, untilTs, seedTs)) tracked.add(s);
    return tracked;
  }

  mid(symbol: string) {
    if (symbol === CRYPTO_SYMBOL) return this.market.ready ? this.market.book.mid : NaN;
    return this.stocks?.book.mid(symbol) ?? NaN;
  }

  midAt(symbol: string, t: number) {
    return symbol === CRYPTO_SYMBOL ? this.market.midAt(t) : (this.stocks?.book.midAt(symbol, t) ?? NaN);
  }

  spreadBps(symbol: string) {
    if (symbol === CRYPTO_SYMBOL) {
      const b = this.market.book;
      return this.market.ready ? ((b.bestAsk - b.bestBid) / b.mid) * 1e4 : NaN;
    }
    return this.stocks?.book.spreadBps(symbol) ?? NaN;
  }

  // Bitcoin's spread on Coinbase is a tiny fraction of a basis point, so its history is not kept.
  spreadAt(symbol: string, t: number) {
    return symbol === CRYPTO_SYMBOL ? NaN : (this.stocks?.book.spreadAt(symbol, t) ?? NaN);
  }

  lastClose(symbol: string) {
    return symbol === CRYPTO_SYMBOL ? NaN : (this.stocks?.lastClose(symbol) ?? NaN);
  }

  tick(now: number) {
    this.stocks?.sweep(now);
  }
}
