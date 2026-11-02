import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeApp, T0 } from './helpers.js';
import { ftsQuery, markSnippet } from '../src/reader.js';
import { absoluteUrl, countWords, minutesFor, pickSrcset, proxiedImage, smarten } from '../public/extract.js';

const DAY = 864e5;
const ARTICLE = readFileSync(new URL('./fixtures/articles/figures-and-code.html', import.meta.url), 'utf8');
const URL_A = 'https://example.com/a';

const words = (n, word = 'compost') => Array.from({ length: n }, () => word).join(' ');

async function savedItem(app, url = URL_A) {
  const { data } = await app.save(url);
  return data.item.id;
}

async function storeContent(app, id, extra = {}) {
  return app.call('POST', `/api/items/${id}/content`, {
    html: '<p>Clean text</p>',
    text: words(460),
    words: 460,
    excerpt: 'An excerpt',
    byline: 'A. Writer',
    ...extra,
  });
}

async function contentRows(app, id) {
  return (await app.db.prepare(`SELECT COUNT(*) AS n FROM contents WHERE item_id = ?`).bind(id).first()).n;
}

test('GET /raw returns the page HTML and the address after redirects', async () => {
  const app = makeApp({ raw: { [URL_A]: { url: 'https://example.com/a/final', html: ARTICLE } } });
  const id = await savedItem(app);
  const { status, data } = await app.call('GET', `/api/items/${id}/raw`);
  assert.equal(status, 200);
  assert.equal(data.url, 'https://example.com/a/final');
  assert.match(data.html, /<pre>/);
});

test('GET /raw answers 422 when the page cannot be fetched, 404 for unknown items', async () => {
  const app = makeApp();
  const id = await savedItem(app);
  const failed = await app.call('GET', `/api/items/${id}/raw`);
  assert.equal(failed.status, 422);
  assert.equal(failed.data.error, 'fetch_failed');
  assert.equal((await app.call('GET', '/api/items/999/raw')).status, 404);
});

test('content is "none" until stored, then comes back with the real reading time', async () => {
  const app = makeApp();
  const id = await savedItem(app);
  const before = await app.call('GET', `/api/items/${id}/content`);
  assert.equal(before.status, 200);
  assert.equal(before.data.status, 'none');
  assert.equal(before.data.html, undefined);

  const saved = await storeContent(app, id);
  assert.equal(saved.status, 200);
  assert.equal(saved.data.words, 460);
  assert.equal(saved.data.minutes, 2); // 460 / 230

  const after = await app.call('GET', `/api/items/${id}/content`);
  assert.equal(after.status, 200);
  assert.equal(after.data.status, 'ok');
  assert.equal(after.data.html, '<p>Clean text</p>');
  assert.equal(after.data.byline, 'A. Writer');
  assert.equal(after.data.progress, 0);

  const { rack } = await app.list();
  assert.equal(rack[0].minutes, 2);
});

test('a failed extraction is stored so no device retries', async () => {
  const app = makeApp();
  const id = await savedItem(app);
  const res = await app.call('POST', `/api/items/${id}/content`, { status: 'failed' });
  assert.equal(res.data.status, 'failed');
  const { status, data } = await app.call('GET', `/api/items/${id}/content`);
  assert.equal(status, 200);
  assert.equal(data.status, 'failed');
  assert.equal(data.html, null);
  const list = await app.call('GET', '/api/contents');
  assert.deepEqual(list.data.contents, [{ id, status: 'failed', words: null }]);
});

test('an article too big for a D1 row is stored as failed', async () => {
  const app = makeApp();
  const id = await savedItem(app);
  const res = await storeContent(app, id, { html: 'x'.repeat(1_300_000) });
  assert.equal(res.data.status, 'failed');
});

test('content can be stored again (re-extraction replaces it)', async () => {
  const app = makeApp();
  const id = await savedItem(app);
  await storeContent(app, id);
  await storeContent(app, id, { html: '<p>Second</p>', text: words(1000, 'second'), words: 1000 });
  const { data } = await app.call('GET', `/api/items/${id}/content`);
  assert.equal(data.html, '<p>Second</p>');
  assert.equal(data.words, 1000);
  assert.equal(await contentRows(app, id), 1);
});

test('progress is clamped, stored with last_read_at, and `seconds` is accepted', async () => {
  const app = makeApp();
  const id = await savedItem(app);
  const res = await app.call('POST', `/api/items/${id}/progress`, { progress: 0.42, seconds: 37 }, { now: T0 + 1000 });
  assert.equal(res.status, 200);
  assert.equal(res.data.progress, 0.42);
  let item = (await app.list()).rack[0];
  assert.equal(item.progress, 0.42);
  assert.equal(item.last_read_at, T0 + 1000);

  await app.call('POST', `/api/items/${id}/progress`, { progress: 7 });
  item = (await app.list()).rack[0];
  assert.equal(item.progress, 1);

  const bad = await app.call('POST', `/api/items/${id}/progress`, { progress: 'half' });
  assert.equal(bad.status, 400);
});

test('progress comes back with the content, for resuming on another device', async () => {
  const app = makeApp();
  const id = await savedItem(app);
  await storeContent(app, id);
  await app.call('POST', `/api/items/${id}/progress`, { progress: 0.6 }, { now: T0 + 5000 });
  const { data } = await app.call('GET', `/api/items/${id}/content`);
  assert.equal(data.progress, 0.6);
  assert.equal(data.last_read_at, T0 + 5000);
});

test('tossing deletes the content; the Heap item cannot be read', async () => {
  const app = makeApp();
  const id = await savedItem(app);
  await storeContent(app, id);
  await app.call('POST', `/api/items/${id}/toss`, {});
  assert.equal(await contentRows(app, id), 0);
  assert.equal((await app.call('GET', `/api/items/${id}/content`)).status, 404);
  assert.equal((await app.call('POST', `/api/items/${id}/progress`, { progress: 0.5 })).status, 404);
});

test('expiry deletes the content', async () => {
  const app = makeApp();
  const id = await savedItem(app);
  await storeContent(app, id);
  await app.list({ now: T0 + 8 * DAY });
  assert.equal(await contentRows(app, id), 0);
});

test('dropping to make room deletes the content', async () => {
  const app = makeApp();
  const first = await savedItem(app, 'https://example.com/0');
  await storeContent(app, first);
  for (let i = 1; i < 10; i++) await app.save(`https://example.com/${i}`);
  const res = await app.save('https://example.com/new', undefined, { dropId: first });
  assert.equal(res.data.status, 'saved');
  assert.equal(await contentRows(app, first), 0);
});

test('Vault items keep their content', async () => {
  const app = makeApp();
  const id = await savedItem(app);
  await storeContent(app, id);
  await app.call('POST', `/api/items/${id}/done`, { takeaway: 'Worth it' });
  assert.equal(await contentRows(app, id), 1);
  assert.equal((await app.call('GET', `/api/items/${id}/content`)).data.status, 'ok');
  // The Heap purge never touches Vault rows.
  await app.list({ now: T0 + 60 * DAY });
  assert.equal(await contentRows(app, id), 1);
});

test('search finds rack and Vault articles by text, title and takeaway, never the Heap', async () => {
  const app = makeApp();
  const rackId = await savedItem(app, 'https://example.com/a');                     // title 'Article A'
  const vaultId = await savedItem(app, 'https://example.com/b');
  const heapId = await savedItem(app, 'https://example.com/c');
  await storeContent(app, rackId, { text: `${words(200)} mycelium networks under the forest` });
  await storeContent(app, vaultId, { text: words(200, 'soil') });
  await storeContent(app, heapId, { text: `${words(200)} mycelium again` });
  await app.call('POST', `/api/items/${vaultId}/done`, { takeaway: 'Worms are underrated' });
  await app.call('POST', `/api/items/${heapId}/toss`, {});

  const byText = await app.call('GET', '/api/search?q=mycel');
  assert.deepEqual(byText.data.results.map((r) => [r.id, r.in]), [[rackId, 'rack']]);
  assert.match(byText.data.results[0].snippet, /<mark>mycelium<\/mark>/);

  const byTakeaway = await app.call('GET', '/api/search?q=worms');
  assert.deepEqual(byTakeaway.data.results.map((r) => [r.id, r.in]), [[vaultId, 'vault']]);

  // 'Article A' in the rack and 'Article B' in the Vault.
  const byTitle = await app.call('GET', '/api/search?q=article');
  assert.deepEqual(byTitle.data.results.map((r) => r.id).sort(), [rackId, vaultId]);

  const empty = await app.call('GET', '/api/search?q=%22%29%28*');
  assert.deepEqual(empty.data.results, []);
});

test('search survives the Heap purge deleting rows', async () => {
  const app = makeApp();
  const id = await savedItem(app);
  await storeContent(app, id, { text: `${words(200)} zebra` });
  await app.call('POST', `/api/items/${id}/toss`, {});
  await app.list({ now: T0 + 40 * DAY });
  const row = await app.db.prepare(`SELECT COUNT(*) AS n FROM search WHERE rowid = ?`).bind(id).first();
  assert.equal(row.n, 0);
  assert.deepEqual((await app.call('GET', '/api/search?q=zebra')).data.results, []);
});

test('ftsQuery turns plain words into a safe query', () => {
  assert.equal(ftsQuery('soil  health'), '"soil" "health"*');
  assert.equal(ftsQuery('NEAR(a b) OR "x'), '"NEAR" "a" "b" "OR" "x"*');
  assert.equal(ftsQuery('  '), null);
  assert.equal(ftsQuery(null), null);
});

test('markSnippet escapes HTML and marks the matches', () => {
  assert.equal(markSnippet('a <b> \u0002hit\u0003 & c'), 'a &lt;b&gt; <mark>hit</mark> &amp; c');
});

// extract.js: the pure helpers (the DOM part runs in the browser smoke test).

test('countWords and minutesFor use 230 words a minute', () => {
  assert.equal(countWords('one two  three — 4'), 4);
  assert.equal(minutesFor(0), null);
  assert.equal(minutesFor(100), 1);
  assert.equal(minutesFor(2300), 10);
});

test('proxiedImage routes images through /img and leaves data URIs alone', () => {
  const base = 'https://news.test/2026/story/';
  assert.equal(proxiedImage('pic.jpg', base), `/img?u=${encodeURIComponent('https://news.test/2026/story/pic.jpg')}`);
  assert.equal(proxiedImage('//cdn.test/a.png', base), `/img?u=${encodeURIComponent('https://cdn.test/a.png')}`);
  assert.equal(proxiedImage('data:image/png;base64,AAA', base), 'data:image/png;base64,AAA');
  assert.equal(proxiedImage('/img?u=x', base), '/img?u=x');
  assert.equal(proxiedImage('javascript:alert(1)', base), null);
  assert.equal(proxiedImage('', base), null);
});

test('absoluteUrl resolves relative links and refuses other schemes', () => {
  assert.equal(absoluteUrl('../x', 'https://a.test/b/c/'), 'https://a.test/b/x');
  assert.equal(absoluteUrl('mailto:me@a.test', 'https://a.test/'), null);
});

test('pickSrcset takes the widest candidate up to 1600px', () => {
  assert.equal(pickSrcset('a.jpg 400w, b.jpg 1200w, c.jpg 2400w'), 'b.jpg');
  assert.equal(pickSrcset('a.jpg 1x, b.jpg 2x'), 'b.jpg');
  assert.equal(pickSrcset('only.jpg'), 'only.jpg');
  assert.equal(pickSrcset(''), null);
});

test('smarten sets curly quotes, apostrophes, dashes and ellipses', () => {
  assert.equal(smarten(`"It's here," she said -- 'quietly'...`), '“It’s here,” she said — ‘quietly’…');
  assert.equal(smarten('"', 'a'), '”');
});
