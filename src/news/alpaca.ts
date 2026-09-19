// Real-time news from Alpaca's news stream (Benzinga), tagged with tickers by the publisher.
// Pushed, so detection is limited by Benzinga and the network, not by a poll interval.

import { AlpacaStream, type AlpacaCreds } from '../feed/alpaca.ts';
import { SeenSet } from '../lib/seen.ts';
import { normalizeSymbol } from './instruments.ts';
import { clean } from './rss.ts';
import type { NewsItem, NewsSource, SourceStats } from './types.ts';

const URL = 'wss://stream.data.alpaca.markets/v1beta1/news';

export function alpacaNewsSource(creds: AlpacaCreds, onItem: (item: NewsItem) => void, log: (s: string) => void): NewsSource {
  const stats: SourceStats = { polls: 0, notModified: 0, items: 0, errors: 0 };
  const seen = new SeenSet();
  const stream = new AlpacaStream({
    url: URL,
    creds,
    onMessage: (m, recvTs) => {
      if (m.T !== 'n') return;
      const headline = clean(String(m.headline ?? ''));
      // Updated articles are re-sent with the same id; the first version is the news event.
      if (!headline || !seen.add(`alpaca:${m.id}`)) return;
      const raw = (m.symbols as string[] | undefined) ?? [];
      const symbols = [...new Set(raw.map(normalizeSymbol).filter((s): s is string => s !== undefined))];
      const published = Date.parse(m.created_at as string);
      const summary = clean(String(m.summary ?? '')).slice(0, 500);
      stats.items++;
      onItem({
        id: `alpaca:${m.id}`,
        source: `alpaca:${m.source ?? 'news'}`,
        sourceLabel: m.source === 'benzinga' || !m.source ? 'Benzinga newswire' : `${m.source} newswire`,
        headline,
        ...(summary ? { summary } : {}),
        ...(m.url ? { url: String(m.url) } : {}),
        ...(Number.isFinite(published) ? { publishedTs: published } : {}),
        recvTs,
        // No tags at all: leave `symbols` unset so the untagged (macro) route applies. Tagged only
        // with instruments we cannot price (e.g. ETHUSD): an empty list, so it is skipped rather
        // than misattributed to the macro route.
        ...(raw.length > 0 ? { symbols } : {}),
      });
    },
    subscription: () => ({ news: ['*'] }),
    onDown: () => stats.errors++,
    log,
  });
  log('[news:alpaca] streaming all news');
  return { name: 'alpaca', stats, close: () => stream.close() };
}
