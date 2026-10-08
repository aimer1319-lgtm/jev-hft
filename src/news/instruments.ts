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
 *
 * Publishers often list funds that hold a company before the company itself ("CrowdStrike
 * Stock Hits 52-Week High" tagged CIBR, BUG, AIPI, CRWD). Measuring a company's news on a fund
 * that holds a sliver of it dilutes the result. So with a company list (`companyName`), funds
 * go after companies, and when the headline names a tagged company, funds it doesn't name are
 * dropped. A ticker missing from the SEC's company list is treated as a fund: that list covers
 * operating companies, and most ETFs are not in it. The index funds that stand for the whole
 * market (SPY, QQQ...) and Bitcoin are never dropped.
 */
export function route(
  item: NewsItem,
  maxSymbols: number,
  untagged: string[],
  companyName?: (ticker: string) => string | undefined,
): string[] {
  const symbols = [...new Set(item.symbols ?? untagged)];
  if (!item.symbols || !companyName || symbols.length < 2) return symbols.slice(0, maxSymbols);
  const name = (s: string) => companyName(s);
  if (!symbols.some(s => name(s))) return symbols.slice(0, maxSymbols); // company list not loaded yet
  const kept = (s: string) => s === CRYPTO_SYMBOL || s in INDEX_FUNDS;
  const isFund = (s: string) => !kept(s) && (!name(s) || FUND.test(name(s)!));
  const named = new Set(symbols.filter(s => headlineNames(item.headline, s, name(s))));
  const ranked = [
    ...symbols.filter(s => named.has(s)),
    ...symbols.filter(s => !named.has(s) && !isFund(s)),
    ...(named.size > 0 ? [] : symbols.filter(isFund)),
  ];
  return ranked.slice(0, maxSymbols);
}

/** Words in a registrant's name that mark a fund or trust rather than an operating company. */
const FUND = /\b(ETF|ETFS|ETN|FUND|FUNDS|TRUST|INDEX|PORTFOLIO)\b/i;

/** Legal suffixes and share-class words that say nothing about which company it is. */
const SUFFIX = new Set('INC CORP CORPORATION CO COMPANY HOLDINGS HOLDING LTD LIMITED PLC SA NV AG LLC LP GROUP THE CLASS CL'.split(' '));

/** First words too common to identify a company on their own ("American", "First"...). */
const GENERIC = new Set('AMERICAN FIRST UNITED GENERAL NATIONAL GLOBAL INTERNATIONAL NEW BANK US U.S. CAPITAL'.split(' '));

/** Does the headline name this company, by its ticker or by the distinctive start of its name? */
export function headlineNames(headline: string, ticker: string, name: string | undefined): boolean {
  if (ticker === CRYPTO_SYMBOL) return /\b(bitcoin|btc)\b/i.test(headline);
  const escaped = ticker.replace('.', '\\.');
  // Tickers are matched case-sensitively, and one- or two-letter ones only as $cashtags or in
  // parentheses, so the article "A" or the word "IT" don't count as mentions.
  const tickerRe = ticker.length <= 2 ? new RegExp(`(\\$${escaped}\\b|\\(${escaped}\\))`) : new RegExp(`(^|[^A-Za-z])\\$?${escaped}([^A-Za-z]|$)`);
  if (tickerRe.test(headline)) return true;
  if (!name) return false;
  const words = name
    .toUpperCase()
    .replace(/[.,]/g, ' ')
    .split(/\s+/)
    .filter(w => w && !SUFFIX.has(w));
  if (words.length === 0) return false;
  const key = GENERIC.has(words[0]!) && words.length > 1 ? `${words[0]} ${words[1]}` : words[0]!;
  if (key.length < 3) return false;
  return new RegExp(`(^|[^A-Za-z])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z]|$)`, 'i').test(headline);
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
