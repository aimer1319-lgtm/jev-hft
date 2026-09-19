import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFiling } from '../src/news/edgar.ts';
import { clean, parseFeed } from '../src/news/rss.ts';
import { CompanyDirectory } from '../src/news/tickers.ts';
import { buildQueries, toItem } from '../src/news/x.ts';

const T0 = 1_800_000_000_000;

test('RSS 2.0: fields, HTML in summaries, and numeric-looking ids kept as text', () => {
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
    <item><title>Fed &amp; Treasury announce plan</title><link>https://example.gov/a</link><guid isPermaLink="false">2026</guid>
      <pubDate>Fri, 18 Sep 2026 18:00:00 GMT</pubDate><description><![CDATA[<p>Rates&nbsp;cut by <b>50</b> bp.</p>]]></description></item>
    <item><title></title><link>https://example.gov/empty</link></item>
  </channel></rss>`;
  const items = parseFeed(xml, 'fed', T0);
  assert.equal(items.length, 1, 'an entry without a headline is not news');
  assert.deepEqual(items[0], {
    id: 'fed:2026',
    source: 'fed',
    headline: 'Fed & Treasury announce plan',
    summary: 'Rates cut by 50 bp.',
    url: 'https://example.gov/a',
    publishedTs: Date.parse('2026-09-18T18:00:00Z'),
    recvTs: T0,
  });
});

test('Atom: a single entry, the alternate link, and the updated time', () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
    <title type="html">Service degraded</title><id>tag:status,2026:1</id>
    <link rel="self" href="https://status.example/self"/><link rel="alternate" href="https://status.example/1"/>
    <updated>2026-09-18T18:00:30Z</updated><summary type="html">&lt;b&gt;Investigating&lt;/b&gt;</summary></entry></feed>`;
  const [i] = parseFeed(xml, 'status', T0);
  assert.equal(i!.id, 'status:tag:status,2026:1');
  assert.equal(i!.url, 'https://status.example/1');
  assert.equal(i!.publishedTs, Date.parse('2026-09-18T18:00:30Z'));
  assert.equal(i!.summary, 'Investigating');
});

test('RSS 1.0 (RDF) and feeds without dates', () => {
  const xml = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/">
    <item><title>One</title><link>https://e.org/1</link><dc:date>2026-09-18T18:00:00Z</dc:date></item>
    <item><title>Two</title><link>https://e.org/2</link></item></rdf:RDF>`;
  const items = parseFeed(xml, 'rdf', T0);
  assert.deepEqual(items.map(i => i.id), ['rdf:https://e.org/1', 'rdf:https://e.org/2']);
  assert.equal(items[1]!.publishedTs, undefined, 'unknown, not zero');
});

test('text cleaning removes tags and decodes entities', () => {
  assert.equal(clean('<a href="x">A&#38;B</a>&nbsp;&#x41; &quot;q&quot;  \n done'), 'A&B A "q" done');
});

test('an SEC filing entry is read into company, number, and what was reported', () => {
  const f = parseFiling(
    '8-K - CISCO SYSTEMS, INC. (0000858877) (Filer)',
    'Filed: 2026-09-18 AccNo: 0000858877-26-000012 Size: 1 MB Item 2.02: Results of Operations and Financial Condition Item 9.01: Financial Statements and Exhibits',
  );
  assert.deepEqual(f, { form: '8-K', company: 'CISCO SYSTEMS, INC.', cik: 858877, events: ['Results of Operations and Financial Condition'] });
  const onlyExhibits = parseFiling('8-K/A - Example Corp (0000000042) (Filer)', 'Filed: 2026-09-18 AccNo: 1 Size: 2 KB Item 9.01: Financial Statements and Exhibits');
  assert.deepEqual(onlyExhibits, { form: '8-K/A', company: 'Example Corp', cik: 42, events: ['Financial Statements and Exhibits'] });
  assert.equal(parseFiling('not a filing title'), undefined);
});

test('the company list: main listing per company, share classes written the way price feeds write them', () => {
  const dir = Object.create(CompanyDirectory.prototype) as CompanyDirectory; // without the download the constructor starts
  Object.assign(dir, { byCik: new Map(), names: new Map(), loaded: false });
  dir.fill([
    { cik_str: 1652044, ticker: 'GOOGL', title: 'Alphabet Inc.' },
    { cik_str: 1652044, ticker: 'GOOG', title: 'Alphabet Inc.' },
    { cik_str: 1067983, ticker: 'BRK-B', title: 'BERKSHIRE HATHAWAY INC' },
  ]);
  assert.equal(dir.loaded, true);
  assert.equal(dir.tickerOf(1652044), 'GOOGL');
  assert.equal(dir.tickerOf(1067983), 'BRK.B');
  assert.equal(dir.nameOf('GOOG'), 'Alphabet Inc.');
  assert.equal(dir.nameOf('BRK.B'), 'BERKSHIRE HATHAWAY INC');
  assert.equal(dir.tickerOf(7), undefined);
});

test('X: accounts are grouped into as few searches as the length limit allows', () => {
  assert.deepEqual(buildQueries(['a', 'b']), ['(from:a OR from:b) -is:retweet -is:reply']);
  const many = Array.from({ length: 60 }, (_, i) => `account_number_${i}`);
  const queries = buildQueries(many);
  assert.ok(queries.length > 1);
  assert.ok(queries.every(q => q.length <= 512));
  assert.equal(queries.join(' ').match(/from:/g)!.length, 60, 'every account is in exactly one search');
});

test('X: a post becomes an item named after its author, with cashtags as instruments', () => {
  const authors = new Map([['42', 'federalreserve']]);
  const post = { id: '9', text: 'Statement on\n$SPY and $ETH', created_at: '2026-09-18T18:00:00.000Z', author_id: '42', entities: { cashtags: [{ tag: 'SPY' }, { tag: 'ETH' }] } };
  assert.deepEqual(toItem(post, authors, T0), {
    id: 'x:9',
    source: 'x:federalreserve',
    sourceLabel: 'X post by @federalreserve',
    headline: 'Statement on $SPY and $ETH',
    url: 'https://x.com/federalreserve/status/9',
    publishedTs: Date.parse('2026-09-18T18:00:00Z'),
    recvTs: T0,
    symbols: ['SPY'],
  });
  const untagged = toItem({ id: '10', text: 'No tags', author_id: '7' }, authors, T0);
  assert.equal(untagged.symbols, undefined, 'no cashtags: the macro route decides');
  assert.equal(untagged.source, 'x:7', 'an author we have not looked up yet is shown by id');
  const unpriceable = toItem({ id: '11', text: '$ETH only', author_id: '42', entities: { cashtags: [{ tag: 'ETH' }] } }, authors, T0);
  assert.deepEqual(unpriceable.symbols, [], 'tagged, but with nothing we can price: skipped downstream');
});
