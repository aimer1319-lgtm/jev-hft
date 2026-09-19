// Which instruments a news item is about, how to name them to the model, and US market hours.

import { CRYPTO_SYMBOL } from '../market/prices.ts';
import type { NewsItem } from './types.ts';

export type AssetClass = 'crypto' | 'equity';
export type Instrument = { symbol: string; assetClass: AssetClass; name: string };

export function instrument(symbol: string): Instrument {
  return symbol === CRYPTO_SYMBOL
    ? { symbol, assetClass: 'crypto', name: 'Bitcoin' }
    : { symbol, assetClass: 'equity', name: `${symbol} stock` };
}

/**
 * The item's own tags when it has them (capped: items tagged with many tickers are usually
 * roundups), otherwise `untagged`. Sources set tags: RSS feeds from their config, Alpaca from
 * Benzinga's tickers, EDGAR from the filer, manual input from $cashtags. An empty tag list means
 * "about something we cannot price" and yields no instruments.
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

export type Session = 'pre' | 'regular' | 'post' | 'closed' | '24/7';

const nyClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** US equity session at time t (Eastern time). Exchange holidays are not modeled. */
export function usSession(t: number): Session {
  const p = Object.fromEntries(nyClock.formatToParts(t).map(x => [x.type, x.value]));
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return 'closed';
  const minute = Number(p.hour) * 60 + Number(p.minute);
  if (minute >= 4 * 60 && minute < 9 * 60 + 30) return 'pre';
  if (minute >= 9 * 60 + 30 && minute < 16 * 60) return 'regular';
  if (minute >= 16 * 60 && minute < 20 * 60) return 'post';
  return 'closed';
}

export const sessionOf = (ins: Instrument, t: number): Session => (ins.assetClass === 'crypto' ? '24/7' : usSession(t));
