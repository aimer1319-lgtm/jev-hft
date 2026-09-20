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
import { fileStamp, log, onStop } from './lib/run.ts';
import { CRYPTO_SYMBOL, LivePrices } from './market/prices.ts';
import { MarketState } from './market/state.ts';
import { createModel, keepWarm } from './model/jev.ts';
import { alpacaNewsSource } from './news/alpaca.ts';
import { edgarSource } from './news/edgar.ts';
import { NewsEngine } from './news/engine.ts';
import { manualSource } from './news/manual.ts';
import { rssSource } from './news/rss.ts';
import { CompanyDirectory } from './news/tickers.ts';
import { xSource } from './news/x.ts';
import type { NewsItem, NewsSource } from './news/types.ts';
import { parseTarget, telemetrySender } from './telemetry/sender.ts';

const stamp = fileStamp();
mkdirSync('data/decisions', { recursive: true });
mkdirSync('data/news', { recursive: true });
const decisionsFile = `data/decisions/news-${config.provider}-${stamp}.jsonl`;
const itemsFile = `data/news/items-${stamp}.jsonl`;
const decisionsOut = createWriteStream(decisionsFile);
const itemsOut = createWriteStream(itemsFile);

// Enough price history for "last 30m" context plus the longest forward horizon.
const retentionMs = (1800 + Math.max(...config.news.horizons)) * 1000 + 5 * 60_000;
const market = new MarketState(retentionMs);
const creds = config.alpaca.key && config.alpaca.secret ? { key: config.alpaca.key, secret: config.alpaca.secret } : undefined;
// Stocks on the general-news route (SPY) are needed all day, so they are followed permanently.
const pinned = config.news.untagged.filter(s => s !== CRYPTO_SYMBOL);
const stocks = creds ? new AlpacaStocks(creds, config.alpaca.feed, config.alpaca.maxSymbols, retentionMs, log, pinned) : undefined;
if (!stocks) log('no Alpaca keys (ALPACA_API_KEY_ID, ALPACA_API_SECRET_KEY): stock instruments will have no prices');
const prices = new LivePrices(market, stocks);

// The SEC's company list names companies in questions and maps filers to tickers. The SEC
// requires automated readers to say who they are, so without NEWS_USER_AGENT it is not used.
const companies = process.env.NEWS_USER_AGENT ? new CompanyDirectory(config.news.userAgent, log) : undefined;

// What the dashboard sees. Fire-and-forget: the pipeline never waits for it (docs/dashboard.md).
const target = parseTarget(process.env.TELEMETRY);
const telemetry = telemetrySender('news', target);

const engine = new NewsEngine(prices, {
  model: createModel(config.provider),
  provider: config.provider,
  horizonsS: config.news.horizons,
  maxAgeMs: config.news.maxAgeMs,
  maxInFlight: config.news.maxInFlight,
  maxSymbolsPerItem: config.news.maxSymbolsPerItem,
  untagged: config.news.untagged,
  timeoutMs: config.news.timeoutMs,
  onlyTradable: config.news.onlyTradable,
  maxSpreadBps: config.news.maxSpreadBps,
  companyName: ticker => companies?.nameOf(ticker),
  emit: telemetry.emit,
  write: rec => decisionsOut.write(JSON.stringify(rec) + '\n'),
  log,
});

const feed = coinbaseFeed(config.product, e => market.apply(e), log);
// The engine runs on its own clock tick, so stock news keeps flowing even if Coinbase is down.
// The same tick tells the dashboard we are alive (nothing is built when telemetry is off).
const sources: NewsSource[] = [];
const pulse = target
  ? () =>
      telemetry.emit({
        type: 'pulse',
        program: 'news',
        meta: { provider: config.provider, onlyTradable: config.news.onlyTradable, maxSpreadBps: config.news.maxSpreadBps, horizonsS: config.news.horizons },
        market: { ready: market.ready, mid: market.ready ? market.book.mid : null },
        stats: { ...engine.stats },
        queued: engine.queued,
        stocks: stocks ? { watching: stocks.stats.watching, max: config.alpaca.maxSymbols, rejected: stocks.stats.rejected, reconnects: stocks.stats.reconnects } : null,
        sources: sources.map(src => ({ name: src.name, ...src.stats })),
      })
  : () => {};
const ticker = setInterval(() => {
  engine.tick(nowMs());
  pulse();
}, 1000);
const stopWarm = keepWarm(config.provider, log);

const onItem = (item: NewsItem) => {
  itemsOut.write(JSON.stringify(item) + '\n');
  const lag = item.publishedTs ? `${((item.recvTs - item.publishedTs) / 1000).toFixed(0)}s after publish` : 'no publish time';
  const tags = item.symbols ? `[${item.symbols.join(',') || 'unpriceable'}]` : '[untagged]';
  log(`NEWS ${item.source} (${lag}) ${tags} ${item.headline}`);
  telemetry.emit({
    type: 'news-item',
    program: 'news',
    id: item.id,
    source: item.source,
    sourceLabel: item.sourceLabel ?? item.source,
    headline: item.headline,
    url: item.url ?? null,
    publishedTs: item.publishedTs ?? null,
    recvTs: item.recvTs,
    symbols: item.symbols ?? null,
  });
  engine.onItem(item);
};

const pollOpts = { intervalMs: config.news.pollMs, fastIntervalMs: config.news.fastPollMs, userAgent: config.news.userAgent, log };
if (config.news.sources.includes('rss')) for (const f of config.news.feeds) sources.push(rssSource(f, pollOpts, onItem));
if (config.news.sources.includes('alpaca')) {
  if (creds) sources.push(alpacaNewsSource(creds, onItem, log));
  else log('alpaca news skipped: no Alpaca keys');
}
if (config.news.sources.includes('edgar')) {
  if (companies) sources.push(edgarSource(companies, pollOpts, onItem));
  else log('edgar skipped: set NEWS_USER_AGENT="Your Name your-email@example.com" (SEC fair access policy)');
}
if (config.news.sources.includes('x')) {
  const { bearer, accounts, pollMs, maxPostsPerDay } = config.x;
  if (bearer) sources.push(xSource({ bearer, accounts, intervalMs: pollMs, maxPostsPerDay, log }, onItem));
  else log('x skipped: set X_BEARER_TOKEN');
}
if (config.news.manual) sources.push(manualSource(onItem, log));

log(
  `news provider=${config.provider} sources=${sources.map(s => s.name).join(',')} stocks=${stocks ? `alpaca/${config.alpaca.feed} (max ${config.alpaca.maxSymbols} live)` : 'none'} ` +
    `${config.news.onlyTradable ? 'asking only about instruments that can be priced now' : 'asking about every routed instrument'} -> ${decisionsFile}` +
    (target ? `\ndashboard telemetry -> udp://${target.host}:${target.port} (npm run dashboard to watch; TELEMETRY=0 turns it off)` : ''),
);

const status = setInterval(() => {
  const s = engine.stats;
  const polled = sources.map(src => `${src.name} ${src.stats.polls}/${src.stats.notModified}/${src.stats.items}${src.stats.errors ? `/err${src.stats.errors}` : ''}`);
  const st = stocks?.stats;
  log(
    `BTC ${market.ready ? market.book.mid.toFixed(2) : '-'}  news ${s.received}  decisions ${s.decisions}  written ${s.written}  queued ${engine.queued}  ` +
      `skipped: repeat ${s.duplicates} closed ${s.closed} no-price ${s.unpriced} untagged-asset ${s.unpriceable}  dropped ${s.dropped}  ` +
      `429s ${s.rateLimited}  retries ${s.retries}  errors ${s.errors}  cost $${s.costUsd.toFixed(4)}` +
      (st ? `  | stocks live ${st.watching} over-limit ${st.rejected} snapshots ${st.snapshots}${st.snapshotErrors ? `/err${st.snapshotErrors}` : ''} reconnects ${st.reconnects}` : '') +
      `  | polls/304/items: ${polled.join('  ')}`,
  );
}, 30_000);

onStop(() => {
  clearInterval(status);
  clearInterval(ticker);
  telemetry.close();
  stopWarm();
  for (const src of sources) src.close();
  companies?.close();
  feed.close();
  stocks?.close();
  engine.flush(nowMs(), true); // horizons that have not elapsed are recorded as unknown
  itemsOut.end();
  decisionsOut.end(() => {
    log(`wrote ${engine.stats.written} news decisions to ${decisionsFile}; items in ${itemsFile}`);
    process.exit(0);
  });
}, config.runMs);
