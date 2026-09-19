// The SEC's public list of listed companies: about 10,000 rows of (company number, ticker, name).
// Two parts of the news path use it: the filing source turns a filer's company number (CIK)
// into a ticker, and questions name companies in full ("Apple Inc. (AAPL)").
//
// It is downloaded once in the background and retried until it arrives. Nothing waits for it:
// until it is there, filings cannot be matched to tickers and questions use bare tickers.

import { backoffMs } from '../lib/poll.ts';

const URL = 'https://www.sec.gov/files/company_tickers.json';

type Row = { cik_str: number; ticker: string; title: string };

export class CompanyDirectory {
  loaded = false;
  private byCik = new Map<number, string>();
  private names = new Map<string, string>();
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  private readonly userAgent: string;
  private readonly log: (s: string) => void;

  /** The SEC asks automated readers to identify themselves, so a user agent is required. */
  constructor(userAgent: string, log: (s: string) => void) {
    this.userAgent = userAgent;
    this.log = log;
    void this.load(0);
  }

  /** The ticker of the company with this SEC company number. */
  tickerOf(cik: number) {
    return this.byCik.get(cik);
  }

  nameOf(ticker: string) {
    return this.names.get(ticker);
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
  }

  /** Fill from rows (exported through `load`; separate so it can be tested without the network). */
  fill(rows: Row[]) {
    for (const row of rows) {
      // The SEC writes share classes with a dash (BRK-B); price feeds use a dot (BRK.B).
      const ticker = row.ticker.toUpperCase().replace('-', '.');
      // The list is ordered by company size with a company's main listing first (GOOGL before GOOG).
      if (!this.byCik.has(row.cik_str)) this.byCik.set(row.cik_str, ticker);
      this.names.set(ticker, row.title);
    }
    this.loaded = true;
  }

  private async load(failures: number) {
    try {
      const res = await fetch(URL, { headers: { 'User-Agent': this.userAgent }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.fill(Object.values((await res.json()) as Record<string, Row>));
      this.log(`[sec] company list loaded: ${this.names.size} tickers`);
    } catch (error) {
      if (this.closed) return;
      const wait = backoffMs(30_000, failures + 1, error as Error, 30 * 60_000);
      this.log(`[sec] company list failed (${(error as Error).message}); retrying in ${(wait / 1000).toFixed(0)}s`);
      this.timer = setTimeout(() => void this.load(failures + 1), wait);
    }
  }
}
