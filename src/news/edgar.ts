// SEC EDGAR current 8-K filings, tagged with the filer's ticker.
//
// The Atom feed gives the filer (with its company number, the CIK) and the item numbers
// reported (e.g. "Item 2.02: Results of Operations"), not the filing's text. The SEC's own
// company list maps filers to tickers; filers without a listed ticker are skipped because they
// cannot be priced.
//
// The feed's wording is written for filing clerks ("8-K - CISCO SYSTEMS, INC. (0000858877)
// (Filer)", "AccNo: ... Size: 1 MB"), so each entry is restated as a plain sentence for the model.

import { normalizeSymbol } from './instruments.ts';
import { rssSource, type PollOptions } from './rss.ts';
import type { CompanyDirectory } from './tickers.ts';
import type { NewsItem, NewsSource } from './types.ts';

const FEED = 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&company=&dateb=&owner=include&start=0&count=40&output=atom';

/** Attached to almost every 8-K and says nothing about what happened. */
const BOILERPLATE = /^Financial Statements and Exhibits$/i;

/** "8-K - CISCO SYSTEMS, INC. (0000858877) (Filer)" -> its parts; undefined if it is not in that shape. */
export function parseFiling(headline: string, summary = '') {
  const m = /^(\S+) - (.+?) \((\d{10})\)/.exec(headline);
  if (!m) return undefined;
  const events = [...summary.matchAll(/Item \d+\.\d+: (.*?)(?= Item \d+\.\d+:|$)/g)].map(x => x[1]!.trim());
  const meaningful = events.filter(e => !BOILERPLATE.test(e));
  return { form: m[1]!, company: m[2]!, cik: Number(m[3]), events: meaningful.length > 0 ? meaningful : events };
}

export function edgarSource(companies: CompanyDirectory, opts: PollOptions, onItem: (item: NewsItem) => void): NewsSource {
  // Filings move prices within minutes and the SEC allows 10 requests a second, so this feed is
  // checked at the fast interval even though it sends its whole content (about 30 KB) each time.
  return rssSource({ name: 'edgar-8k', label: 'SEC filing (EDGAR)', url: FEED, fast: true }, opts, item => {
    const filing = parseFiling(item.headline, item.summary);
    const listed = filing && companies.tickerOf(filing.cik);
    const ticker = listed && normalizeSymbol(listed);
    if (!filing || !ticker) return; // no listed ticker (or the company list has not loaded yet)
    const { summary: _feedSummary, ...rest } = item;
    const what = filing.events.length > 0 ? `: ${filing.events.join('; ')}` : '';
    onItem({
      ...rest,
      headline: `${filing.company} (${ticker}) filed ${filing.form.endsWith('/A') ? 'an amended 8-K' : 'an 8-K'} report with the SEC${what}`,
      symbols: [ticker],
    });
  });
}
