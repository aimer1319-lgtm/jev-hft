import type { Encoding } from './market/encode.ts';
import type { FeedConfig } from './news/rss.ts';

/** Numeric env var: unset or empty means the default; anything non-numeric is an error. */
export const envNum = (name: string, fallback: number, { min = -Infinity } = {}) => {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (Number.isNaN(n) || n < min) throw new Error(`${name} must be a number >= ${min}, got "${v}"`);
  return n;
};
const num = envNum;

/**
 * Public feeds polled by default, with the instruments their news is about. Fed releases are
 * macro news, so they are routed to the broad US market (SPY) as well as Bitcoin.
 * Override with NEWS_FEEDS="name=url name=url ..." (custom feeds route to Bitcoin).
 */
export const DEFAULT_FEEDS: FeedConfig[] = [
  { name: 'fed', url: 'https://www.federalreserve.gov/feeds/press_all.xml', symbols: ['SPY', 'BTC-USD'] },
  { name: 'cftc', url: 'https://www.cftc.gov/RSS/RSSGP/rssgp.xml', symbols: ['BTC-USD'] },
  { name: 'coinbase-status', url: 'https://status.coinbase.com/history.atom', symbols: ['BTC-USD'] },
  { name: 'coindesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss', symbols: ['BTC-USD'] },
  { name: 'cointelegraph', url: 'https://cointelegraph.com/rss', symbols: ['BTC-USD'] },
];

function feeds(spec: string | undefined): FeedConfig[] {
  if (!spec) return DEFAULT_FEEDS;
  return spec
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(pair => {
      const eq = pair.indexOf('=');
      if (eq < 1) throw new Error(`NEWS_FEEDS entries must be name=url, got "${pair}"`);
      return { name: pair.slice(0, eq), url: pair.slice(eq + 1), symbols: ['BTC-USD'] };
    });
}

const alpacaFeed = process.env.ALPACA_FEED || 'iex';

/** Official accounts followed on X by default: US economic agencies and market regulators, and Coinbase. */
export const DEFAULT_X_ACCOUNTS = ['federalreserve', 'SECGov', 'CFTC', 'USTreasury', 'BLS_gov', 'coinbase'];

export const config = {
  product: process.env.PRODUCT || 'BTC-USD',
  provider: process.env.JEV_PROVIDER || 'gateway',
  encoding: (process.env.JEV_ENCODING || 'compact') as Encoding,
  /** Minimum spacing between decisions. 0 = fire again as soon as a slot frees up. */
  minIntervalMs: num('JEV_MIN_INTERVAL_MS', 0),
  /** Concurrent model calls. >1 raises decision rate, not decision freshness. */
  maxInFlight: num('JEV_MAX_INFLIGHT', 1),
  /** Abandon a call after this long; its answer would be too stale to act on. */
  timeoutMs: num('JEV_TIMEOUT_MS', 2000),
  /** Let returns, volatility, and z-score windows fill before deciding. */
  warmupMs: num('WARMUP_S', 60) * 1000,
  runMs: num('RUN_MINUTES', 0) * 60_000,
  /** Forward-return horizons (seconds) recorded for every decision. */
  horizons: [1, 2, 5, 10, 30, 60],
  /** Round-trip trading cost used as the hurdle in analysis (fees + half-spread x2). */
  feeBps: num('FEE_BPS', 10),

  alpaca: {
    key: process.env.ALPACA_API_KEY_ID || '',
    secret: process.env.ALPACA_API_SECRET_KEY || '',
    /** 'iex' (free plan: one exchange) or 'sip' (paid plan: all US exchanges). */
    feed: alpacaFeed,
    /** Live quote subscriptions at once; the free plan allows 30. */
    maxSymbols: envNum('ALPACA_MAX_SYMBOLS', alpacaFeed === 'iex' ? 30 : 1000, { min: 1 }),
  },

  x: {
    bearer: process.env.X_BEARER_TOKEN || '',
    accounts: (process.env.X_ACCOUNTS || DEFAULT_X_ACCOUNTS.join(' ')).split(/[\s,]+/).filter(Boolean).map(a => a.replace(/^@/, '')),
    /** Seconds between searches; each search covers all accounts. */
    pollMs: envNum('X_POLL_S', 30, { min: 5 }) * 1000,
    /** Posts read per UTC day before the source pauses (X bills per post read). */
    maxPostsPerDay: envNum('X_MAX_POSTS_PER_DAY', 500, { min: 1 }),
  },

  news: {
    /** Which sources to run: rss, alpaca (needs Alpaca keys), edgar (needs NEWS_USER_AGENT), x (needs X_BEARER_TOKEN). */
    sources: (process.env.NEWS_SOURCES || 'rss,alpaca,edgar,x').split(',').map(s => s.trim()),
    feeds: feeds(process.env.NEWS_FEEDS),
    /** At most this many instruments per item; items tagged with many tickers are usually roundups. */
    maxSymbolsPerItem: envNum('NEWS_MAX_SYMBOLS', 3, { min: 1 }),
    /** Route for tagged-source items without tickers (macro news): broad market and Bitcoin. */
    untagged: ['SPY', 'BTC-USD'],
    /** Per-feed poll interval. Detection latency averages about half of this plus the publisher's own lag. */
    pollMs: Math.max(num('NEWS_POLL_S', 30), 5) * 1000,
    userAgent: process.env.NEWS_USER_AGENT || 'jev-research/0.1 (news poller)',
    manual: process.env.NEWS_MANUAL === '1',
    /** Give up on a rate-limited item after this long in the queue. */
    maxAgeMs: num('NEWS_MAX_AGE_S', 300) * 1000,
    /** Forward-return horizons (seconds) recorded for each news decision. */
    horizons: [10, 30, 60, 300, 900, 1800],
  },
};
