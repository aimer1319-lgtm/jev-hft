// Real-time news from Alpaca's news stream (Benzinga), tagged with tickers by the publisher.
// Pushed, so detection is limited by Benzinga and the network, not by a poll interval.

import { AlpacaStream, type AlpacaCreds } from '../feed/alpaca.ts';
import { normalizeSymbol } from './instruments.ts';
import type { NewsItem, NewsSource, SourceStats } from './types.ts';

const URL = 'wss://stream.data.alpaca.markets/v1beta1/news';
const MAX_SEEN = 5000;

export function alpacaNewsSource(creds: AlpacaCreds, onItem: (item: NewsItem) => void, log: (s: string) => void): NewsSource {
  const stats: SourceStats = { polls: 0, notModified: 0, items: 0, errors: 0 };
  const seen = new Set<string>();
  const stream = new AlpacaStream(
    URL,
    creds,
    (m, recvTs) => {
      if (m.T !== 'n') return;
      // Updated articles are re-sent with the same id; the first version is the news event.
      const id = `alpaca:${m.id}`;
      if (seen.has(id)) return;
      seen.add(id);
      if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value!);
      const raw = (m.symbols as string[] | undefined) ?? [];
      const symbols = [...new Set(raw.map(normalizeSymbol).filter((s): s is string => s !== undefined))];
      const published = Date.parse(m.created_at as string);
      const summary = String(m.summary ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
      stats.items++;
      onItem({
        id,
        source: `alpaca:${m.source ?? 'news'}`,
        headline: String(m.headline ?? '').trim(),
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
    () => ({ news: ['*'] }),
    log,
  );
  log('[news:alpaca] streaming all news');
  return { name: 'alpaca', stats, close: () => stream.close() };
}
