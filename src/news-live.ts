// Live news pipeline: news sources -> instruments -> Jev -> decision log, with Coinbase (Bitcoin)
// and Alpaca (US stocks) running alongside for prices and forward returns. Paper only.
//
//   npm run news                                     # all configured sources, gateway
//   NEWS_MANUAL=1 JEV_PROVIDER=mock npm run news     # type headlines ($AAPL, $BTC), simulated model

import { createWriteStream, mkdirSync } from 'node:fs';
import { config } from './config.ts';
import { AlpacaStocks } from './feed/alpaca-stocks.ts';
import { coinbaseFeed } from './feed/coinbase.ts';
import { nowMs } from './feed/types.ts';
import { LivePrices } from './market/prices.ts';
import { MarketState } from './market/state.ts';
import { createModel } from './model/jev.ts';
import { alpacaNewsSource } from './news/alpaca.ts';
import { edgarSource } from './news/edgar.ts';
import { NewsEngine } from './news/engine.ts';
import { manualSource } from './news/manual.ts';
import { rssSource } from './news/rss.ts';
import { xSource } from './news/x.ts';
import type { NewsItem, NewsSource } from './news/types.ts';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
mkdirSync('data/decisions', { recursive: true });
mkdirSync('data/news', { recursive: true });
const decisionsFile = `data/decisions/news-${config.provider}-${stamp}.jsonl`;
const itemsFile = `data/news/items-${stamp}.jsonl`;
const decisionsOut = createWriteStream(decisionsFile);
const itemsOut = createWriteStream(itemsFile);
const log = (s: string) => console.error(`${new Date().toISOString().slice(11, 19)} ${s}`);

// Enough price history for "last 30m" context plus the longest forward horizon.
const retentionMs = (1800 + Math.max(...config.news.horizons)) * 1000 + 5 * 60_000;
const market = new MarketState(retentionMs);
const creds = config.alpaca.key && config.alpaca.secret ? { key: config.alpaca.key, secret: config.alpaca.secret } : undefined;
const stocks = creds ? new AlpacaStocks(creds, config.alpaca.feed, config.alpaca.maxSymbols, retentionMs, log) : undefined;
if (!stocks) log('no Alpaca keys (ALPACA_API_KEY_ID, ALPACA_API_SECRET_KEY): stock instruments will have no prices');
const prices = new LivePrices(market, stocks);

const engine = new NewsEngine(prices, {
  model: createModel(config.provider),
  provider: config.provider,
  horizonsS: config.news.horizons,
  maxAgeMs: config.news.maxAgeMs,
  maxInFlight: config.maxInFlight,
  maxSymbolsPerItem: config.news.maxSymbolsPerItem,
  untagged: config.news.untagged,
  timeoutMs: config.timeoutMs,
  write: rec => decisionsOut.write(JSON.stringify(rec) + '\n'),
  log,
});

const feed = coinbaseFeed(config.product, e => {
  market.apply(e);
  engine.tick(e.recvTs);
});

const onItem = (item: NewsItem) => {
  itemsOut.write(JSON.stringify(item) + '\n');
  const lag = item.publishedTs ? `${((item.recvTs - item.publishedTs) / 1000).toFixed(0)}s after publish` : 'no publish time';
  const tags = item.symbols ? `[${item.symbols.join(',') || 'unpriceable'}]` : '[untagged]';
  log(`NEWS ${item.source} (${lag}) ${tags} ${item.headline}`);
  engine.onItem(item);
};

const sources: NewsSource[] = [];
const pollOpts = { intervalMs: config.news.pollMs, userAgent: config.news.userAgent, log };
if (config.news.sources.includes('rss')) for (const f of config.news.feeds) sources.push(rssSource(f, pollOpts, onItem));
if (config.news.sources.includes('alpaca')) {
  if (creds) sources.push(alpacaNewsSource(creds, onItem, log));
  else log('alpaca news skipped: no Alpaca keys');
}
if (config.news.sources.includes('edgar')) {
  if (process.env.NEWS_USER_AGENT) {
    try {
      sources.push(await edgarSource(pollOpts, onItem));
    } catch (error) {
      log(`edgar skipped: ${(error as Error).message}`);
    }
  } else log('edgar skipped: set NEWS_USER_AGENT="Your Name your-email@example.com" (SEC fair access policy)');
}
if (config.news.sources.includes('x')) {
  const { bearer, accounts, pollMs, maxPostsPerDay } = config.x;
  if (bearer) sources.push(xSource({ bearer, accounts, intervalMs: pollMs, maxPostsPerDay, log }, onItem));
  else log('x skipped: set X_BEARER_TOKEN');
}
if (config.news.manual) sources.push(manualSource(onItem, log));

log(`news provider=${config.provider} sources=${sources.map(s => s.name).join(',')} stocks=${stocks ? `alpaca/${config.alpaca.feed} (max ${config.alpaca.maxSymbols} live)` : 'none'} -> ${decisionsFile}`);

const status = setInterval(() => {
  const s = engine.stats;
  const polled = sources.map(src => `${src.name} ${src.stats.polls}/${src.stats.notModified}/${src.stats.items}${src.stats.errors ? `/err${src.stats.errors}` : ''}`);
  const st = stocks?.stats;
  log(
    `BTC ${market.ready ? market.book.mid.toFixed(2) : '-'}  news ${s.received}  decisions ${s.decisions}  written ${s.written}  queued ${engine.queued}  ` +
      `skipped ${s.skipped}  dropped ${s.dropped}  429s ${s.rateLimited}  errors ${s.errors}` +
      (st ? `  | stocks live ${st.watching} over-limit ${st.rejected} snapshots ${st.snapshots}${st.snapshotErrors ? `/err${st.snapshotErrors}` : ''}` : '') +
      `  | polls/304/items: ${polled.join('  ')}`,
  );
}, 30_000);

const stop = () => {
  clearInterval(status);
  for (const src of sources) src.close();
  feed.close();
  stocks?.close();
  engine.flush(nowMs(), true); // horizons that have not elapsed are recorded as NaN
  itemsOut.end();
  decisionsOut.end(() => {
    log(`wrote ${engine.stats.written} news decisions to ${decisionsFile}; items in ${itemsFile}`);
    process.exit(0);
  });
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
if (config.runMs > 0) setTimeout(stop, config.runMs);
