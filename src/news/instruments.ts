// Which instruments a news item is about, and how to name them to the model.

import { CRYPTO_SYMBOL } from '../market/prices.ts';
import { usSession, type Session } from '../market/sessions.ts';
import type { NewsItem } from './types.ts';

export type { Session } from '../market/sessions.ts';
export type AssetClass = 'crypto' | 'equity';
export type Instrument = { symbol: string; assetClass: AssetClass; name: string };

/** Funds that stand for a whole market. A bare ticker would hide what the question is about. */
const INDEX_FUNDS: Record<string, string> = {
  SPY: 'the S&P 500 index (SPY ETF)',
  QQQ: 'the Nasdaq-100 index (QQQ ETF)',
  DIA: 'the Dow Jones Industrial Average (DIA ETF)',
  IWM: 'the Russell 2000 small-cap index (IWM ETF)',
};

/**
 * `companyName` looks a ticker up in the SEC's company list when that list is loaded, so the
 * model reads "Apple Inc. (AAPL)" rather than a bare ticker it may not recognize.
 */
export function instrument(symbol: string, companyName?: (ticker: string) => string | undefined): Instrument {
  if (symbol === CRYPTO_SYMBOL) return { symbol, assetClass: 'crypto', name: 'Bitcoin' };
  const company = companyName?.(symbol);
  return { symbol, assetClass: 'equity', name: INDEX_FUNDS[symbol] ?? (company ? `${company} (${symbol})` : `${symbol} stock`) };
}

/**
 * The item's own tags when it has them (capped: items tagged with many tickers are usually
 * roundups), otherwise `untagged`. Sources set tags: RSS feeds from their config, Alpaca from
 * Benzinga's tickers, EDGAR from the filer, X and manual input from $cashtags. An empty tag
 * list means "about something we cannot price" and yields no instruments.
 */
export function route(item: NewsItem, maxSymbols: number, untagged: string[]): string[] {
  return [...new Set(item.symbols ?? untagged)].slice(0, maxSymbols);
}

/** Normalize a source's ticker ('BTCUSD', 'BTC', 'AAPL', 'BRK.B'); undefined if we cannot price it. */
export function normalizeSymbol(raw: string): string | undefined {
  const s = raw.trim().toUpperCase();
  if (s === 'BTCUSD' || s === 'BTC' || s === 'BTC-USD' || s === 'BTC/USD') return CRYPTO_SYMBOL;
  return /^[A-Z]{1,5}(\.[A-Z])?$/.test(s) ? s : undefined;
}

/**
 * Other cryptocurrencies. Several of their symbols are also real US stock tickers (ETH, SOL,
 * LINK...), so a "$ETH" written by a person must not be priced as that unrelated stock.
 */
const OTHER_CRYPTO = new Set(
  'ETH SOL XRP DOGE ADA BNB USDT USDC LTC LINK AVAX DOT MATIC POL SHIB TRX BCH XLM ATOM UNI NEAR APT ARB OP SUI TON PEPE AAVE ALGO FIL HBAR ICP INJ'.split(' '),
);

/**
 * A $cashtag typed by a person (X posts, manual input). Unlike a publisher's ticker tags, these
 * are ambiguous, and in practice "$SOL" means the cryptocurrency.
 */
export function normalizeCashtag(raw: string): string | undefined {
  return OTHER_CRYPTO.has(raw.trim().toUpperCase()) ? undefined : normalizeSymbol(raw);
}

export { usSession };

export const sessionOf = (ins: Instrument, t: number): Session => (ins.assetClass === 'crypto' ? '24/7' : usSession(t));
