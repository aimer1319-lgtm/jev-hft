// SEC EDGAR current 8-K filings, tagged with the filer's ticker.
//
// The Atom feed gives the filer (with its CIK) and the item numbers reported (e.g. "Item 2.02:
// Results of Operations"), not the filing's text. The SEC's own CIK -> ticker file maps filers
// to symbols; filers without a listed ticker are skipped because they cannot be priced.

import { rssSource, type PollOptions } from './rss.ts';
import type { NewsItem, NewsSource } from './types.ts';

const FEED = 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&company=&dateb=&owner=include&start=0&count=40&output=atom';
const TICKERS = 'https://www.sec.gov/files/company_tickers.json';

type TickerRow = { cik_str: number; ticker: string; title: string };

export async function edgarSource(opts: PollOptions, onItem: (item: NewsItem) => void): Promise<NewsSource> {
  const res = await fetch(TICKERS, { headers: { 'User-Agent': opts.userAgent }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`SEC ticker list: HTTP ${res.status}`);
  // The file lists a filer's primary listing first (e.g. GOOGL before GOOG); keep that one.
  const tickers = new Map<number, string>();
  for (const row of Object.values((await res.json()) as Record<string, TickerRow>)) {
    if (!tickers.has(row.cik_str)) tickers.set(row.cik_str, row.ticker);
  }
  opts.log(`[news:edgar-8k] ${tickers.size} filers with tickers loaded`);

  const source = rssSource({ name: 'edgar-8k', url: FEED }, opts, item => {
    const cik = Number(/\((\d{10})\)/.exec(item.headline)?.[1]);
    const ticker = tickers.get(cik);
    if (ticker) onItem({ ...item, symbols: [ticker] });
  });
  return source;
}
