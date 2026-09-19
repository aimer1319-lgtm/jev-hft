// Headlines typed (or piped) on stdin, one per line. For trying questions and checking the
// end-to-end path without waiting for real news. $cashtags choose instruments ("$AAPL ...",
// "$BTC ..."); a line without any uses the untagged route.

import { createInterface } from 'node:readline';
import { nowMs } from '../feed/types.ts';
import { normalizeCashtag } from './instruments.ts';
import type { NewsItem, NewsSource, SourceStats } from './types.ts';

export function manualSource(onItem: (item: NewsItem) => void, log: (s: string) => void): NewsSource {
  const stats: SourceStats = { polls: 0, notModified: 0, items: 0, errors: 0 };
  const rl = createInterface({ input: process.stdin });
  rl.on('line', line => {
    const headline = line.trim();
    if (!headline) return;
    const now = nowMs();
    const tags = [...headline.matchAll(/\$([A-Za-z]{1,5}(?:\.[A-Za-z])?)\b/g)].map(m => normalizeCashtag(m[1]!));
    const symbols = tags.filter((s): s is string => s !== undefined);
    stats.items++;
    // Described to the model as a newswire, so a typed headline is judged like a real one.
    onItem({ id: `manual:${stats.items}`, source: 'manual', sourceLabel: 'newswire', headline, publishedTs: now, recvTs: now, ...(tags.length ? { symbols } : {}) });
  });
  log('[news:manual] type a headline and press Enter');
  return { name: 'manual', stats, close: () => rl.close() };
}
