// Event study over news decisions from `npm run news`.
//   1. Acquisition: publish -> received -> answer, per source.
//   2. Which news matters: realized |move| after items Jev rates relevant vs not, and rank
//      correlation of its magnitude score with the realized |move|. This is a volatility
//      question and is usually easier to answer than direction.
//   3. Direction: relevance-weighted signal vs signed move, among relevant items.
//   4. Timing: how much moved before we saw the item and while Jev was answering.
//   5. The items, most relevant first.
//
//   npm run analyze:news -- data/decisions/news-*.jsonl
//   RELEVANT_P=0.6 npm run analyze:news -- <files>

import { readFileSync } from 'node:fs';
import { config, envNum } from './config.ts';
import { bps, mean, spearman, summarize } from './lib/stats.ts';
import type { NewsRecord } from './news/engine.ts';

const files = process.argv.slice(2);
if (files.length === 0) throw new Error('usage: npm run analyze:news -- <news decisions.jsonl> [...]');
const recs: NewsRecord[] = files.flatMap(f =>
  readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l)),
);
if (recs.length === 0) throw new Error('no news decisions in input');
// Records written before multi-asset support covered Bitcoin only.
for (const r of recs) {
  r.symbol ??= 'BTC-USD';
  r.assetClass ??= 'crypto';
  r.tracked ??= true;
}

const threshold = envNum('RELEVANT_P', 0.5);
/** Stock quotes wider than this are not prices (after-hours IEX quotes can be 10% wide). */
const maxSpread = envNum('MAX_SPREAD_BPS', 50, { min: 0 });
const horizons = config.news.horizons;
const fmt = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '-');
const pad = (s: string | number, n: number) => String(s).padStart(n);
const label = (h: number) => (h < 60 ? `${h}s` : `${h / 60}m`);
const priced = (r: NewsRecord) => r.assetClass === 'crypto' || r.spreadBps <= maxSpread;
// Tradable move: from the answer's arrival. Unknown when the quote was too wide to be a price.
const move = (r: NewsRecord, h: number) => (priced(r) ? bps(r.fwdResp[h], r.midResp) : NaN);

const bySource = new Map<string, number>();
for (const r of recs) bySource.set(r.item.source, (bySource.get(r.item.source) ?? 0) + 1);
const classes = [...new Set(recs.map(r => r.assetClass))];
const count = (xs: NewsRecord[], key: (r: NewsRecord) => string) => {
  const m = new Map<string, number>();
  for (const r of xs) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
  return [...m].map(([k, n]) => `${k} ${n}`).join(', ');
};
console.log(`${recs.length} news decisions (one per item and instrument) from ${files.length} file(s)`);
console.log(`sources: ${[...bySource].map(([s, n]) => `${s} ${n}`).join(', ')}`);
console.log(`instruments: ${count(recs, r => r.assetClass)}; stock sessions: ${count(recs.filter(r => r.assetClass === 'equity'), r => r.session) || '-'}; untracked (no forward prices): ${recs.filter(r => !r.tracked).length}; stock quotes wider than ${maxSpread}bp (excluded from moves): ${recs.filter(r => !priced(r)).length}`);
console.log('small samples: treat everything below as anecdotal until there are hundreds of relevant items\n');

// ---- 1. acquisition ------------------------------------------------------------
console.log('ACQUISITION                          n      p50      p90');
const line = (name: string, xs: number[], unit: string, d = 1) => {
  const s = summarize(xs.filter(Number.isFinite));
  console.log(`  ${name.padEnd(32)} ${pad(s.n, 4)}  ${pad(fmt(s.p50, d) + unit, 7)}  ${pad(fmt(s.p90, d) + unit, 7)}`);
};
for (const source of bySource.keys()) {
  const rs = recs.filter(r => r.item.source === source && r.item.publishedTs && source !== 'manual');
  if (rs.length) line(`${source}: publish -> received`, rs.map(r => (r.item.recvTs - r.item.publishedTs!) / 1000), 's', 0);
}
line('queue wait (rate limits)', recs.map(r => r.queueMs / 1000), 's');
line('model round trip', recs.map(r => r.modelMs), 'ms', 0);
console.log('  publish times are what the feed claims (often minute precision), so treat them as bounds\n');

function report(name: string, recs: NewsRecord[]) {
  const relevant = recs.filter(r => r.relevant >= threshold);
  const other = recs.filter(r => r.relevant < threshold);
  // ---- 2. which news matters ---------------------------------------------------------
  console.log(`[${name}] WHICH NEWS MATTERS    mean |move| after the answer arrived (bp); magnitude IC = rank corr(magnitude, |move|)`);
  console.log('  horizon   relevant      not relevant   magnitude IC   relevance IC');
  for (const h of horizons) {
    const absRel = relevant.map(r => Math.abs(move(r, h)));
    const absOther = other.map(r => Math.abs(move(r, h)));
    const absAll = recs.map(r => Math.abs(move(r, h)));
    const magIc = spearman(recs.map(r => r.magnitude), absAll);
    const relIc = spearman(recs.map(r => r.relevant), absAll);
    const n = (xs: number[]) => xs.filter(Number.isFinite).length;
    console.log(
      `  ${pad(label(h), 7)}   ${pad(fmt(mean(absRel), 2), 6)} (n${pad(n(absRel), 3)})  ${pad(fmt(mean(absOther), 2), 6)} (n${pad(n(absOther), 3)})  ${pad(fmt(magIc, 3), 12)}  ${pad(fmt(relIc, 3), 13)}`,
    );
  }
  console.log('');

  // ---- 3. direction ----------------------------------------------------------------
  console.log(`[${name}] DIRECTION (relevant items)    signal = P(relevant) x (P(bullish) - P(bearish)) vs signed move`);
  console.log(`  horizon     n      IC   hit%   net edge bp (cost ${config.feeBps}bp)`);
  for (const h of horizons) {
    const pairs = relevant.map(r => [r.signal, move(r, h)] as const).filter(([s, m]) => Number.isFinite(m) && s !== 0);
    const ic = spearman(pairs.map(p => p[0]), pairs.map(p => p[1]));
    const hits = pairs.filter(([s, m]) => m !== 0 && Math.sign(s) === Math.sign(m));
    const decided = pairs.filter(([, m]) => m !== 0);
    const edge = mean(pairs.map(([s, m]) => Math.sign(s) * m)) - config.feeBps;
    console.log(`  ${pad(label(h), 7)}  ${pad(pairs.length, 4)}  ${pad(fmt(ic, 3), 6)}  ${pad(fmt((hits.length / decided.length) * 100, 0), 5)}  ${pad(fmt(edge, 2), 12)}`);
  }
  console.log('');

  // ---- 4. timing -----------------------------------------------------------------------
  console.log(`[${name}] TIMING (relevant items)    mean |move| before we could act (bp)`);
  const before = relevant.filter(priced).map(r => Math.abs(bps(r.midRecv, r.midPublished)));
  const during = relevant.filter(priced).map(r => Math.abs(bps(r.midResp, r.midRecv)));
  console.log(`  publish -> received: ${fmt(mean(before), 2)} (n${before.filter(Number.isFinite).length})   received -> answer: ${fmt(mean(during), 2)} (n${during.filter(Number.isFinite).length})\n`);
}

for (const c of classes) report(c, recs.filter(r => r.assetClass === c));

// ---- 5. items ----------------------------------------------------------------------
const shown = [60, 300, 1800].filter(h => horizons.includes(h));
console.log(`ITEMS (most relevant first)   symbol   rel  bull bear  mag  novel | move from answer: ${shown.map(label).join(' / ')} (bp)`);
for (const r of [...recs].sort((a, b) => b.relevant - a.relevant).slice(0, envNum('SHOW', 25, { min: 0 }))) {
  const t = new Date(r.item.recvTs).toISOString().slice(5, 19).replace('T', ' ');
  const moves = shown.map(h => pad(fmt(move(r, h), 1), 6)).join(' ');
  console.log(
    `  ${t} ${r.item.source.padEnd(15).slice(0, 15)} ${r.symbol.padEnd(8)} ${fmt(r.relevant, 2)} ${fmt(r.direction.bullish ?? 0, 2)} ${fmt(r.direction.bearish ?? 0, 2)} ${fmt(r.magnitude, 2)} ${fmt(r.novel, 2)} |${moves} | ${r.item.headline.slice(0, 70)}`,
  );
}
