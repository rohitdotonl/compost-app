// Phase 1: page details on save, the note, the refresh action and the image
// proxy behind its cookie.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/worker.js';
import { imgToken } from '../src/img.js';
import { makeApp, PASSCODE, T0 } from './helpers.js';

const RICH = {
  title: 'The Quiet Shelf', minutes: 6, description: 'A small shelf beats a queue.',
  image: 'https://cdn.test/shelf.jpg', favicon: 'https://rich.test/favicon.ico', author: 'Mira Okafor', lang: 'en',
};

test('a save stores the description, image, favicon, author and language', async () => {
  const app = makeApp({ pages: { 'https://rich.test/a': RICH } });
  const { data } = await app.save('https://rich.test/a');
  const item = data.item;
  assert.equal(item.description, RICH.description);
  assert.equal(item.image_url, RICH.image);
  assert.equal(item.favicon_url, RICH.favicon);
  assert.equal(item.author, RICH.author);
  assert.equal(item.lang, 'en');
  assert.equal(item.note, null);
});

test('a save takes an optional note, cleaned and capped at 200 characters', async () => {
  const app = makeApp();
  const { data } = await app.save('https://example.com/a', {}, { note: '  for   the\nessay  ' });
  assert.equal(data.item.note, 'for the essay');
  const long = await app.save('https://example.com/b', {}, { note: 'x'.repeat(500) });
  assert.equal(long.data.item.note.length, 200);
  const odd = await app.save('https://example.com/c', {}, { note: 42 });
  assert.equal(odd.data.item.note, null);
});

test('a second save of a rack URL with a note sets the note and still answers in_rack', async () => {
  const app = makeApp();
  const first = await app.save('https://example.com/a');
  const second = await app.save('https://example.com/a', {}, { title: 'Article A', note: 'why: the chart' });
  assert.equal(second.data.status, 'in_rack');
  assert.equal(second.data.id, first.data.item.id);
  const [row] = (await app.list()).rack;
  assert.equal(row.note, 'why: the chart');
  // Without a note, an existing note stays.
  await app.save('https://example.com/a');
  assert.equal((await app.list()).rack[0].note, 'why: the chart');
});

test('POST /:id/note sets and clears the note, rack items only', async () => {
  const app = makeApp();
  const { data } = await app.save('https://example.com/a');
  const id = data.item.id;
  const set = await app.call('POST', `/api/items/${id}/note`, { note: 'read before Friday' });
  assert.equal(set.status, 200);
  assert.equal(set.data.item.note, 'read before Friday');
  const cleared = await app.call('POST', `/api/items/${id}/note`, { note: '' });
  assert.equal(cleared.data.item.note, null);
  await app.call('POST', `/api/items/${id}/toss`, {});
  assert.equal((await app.call('POST', `/api/items/${id}/note`, { note: 'x' })).status, 404);
});

test('POST /:id/refresh fetches the page again and keeps what it cannot find', async () => {
  const pages = {};
  const app = makeApp({ pages });
  const { data } = await app.save('https://rich.test/a', {}, { note: 'keep me' });
  assert.equal(data.item.title, 'https://rich.test/a');
  pages['https://rich.test/a'] = RICH;
  const res = await app.call('POST', `/api/items/${data.item.id}/refresh`, {});
  assert.equal(res.status, 200);
  assert.equal(res.data.item.title, 'The Quiet Shelf');
  assert.equal(res.data.item.image_url, RICH.image);
  assert.equal(res.data.item.minutes, 6);
  assert.equal(res.data.item.note, 'keep me');
  // A failed fetch leaves the details as they were.
  delete pages['https://rich.test/a'];
  const again = await app.call('POST', `/api/items/${data.item.id}/refresh`, {});
  assert.equal(again.data.item.title, 'The Quiet Shelf');
  assert.equal(again.data.item.description, RICH.description);
  assert.equal((await app.call('POST', '/api/items/999/refresh', {})).status, 404);
});

// ---------------------------------------------------------------------------
// Image proxy
// ---------------------------------------------------------------------------

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fakeNetwork() {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith('/pic.png')) return new Response(PNG, { headers: { 'Content-Type': 'image/png' } });
    if (url.endsWith('/page.html')) return new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } });
    if (url.endsWith('/huge.jpg')) return new Response(new Uint8Array(2_000_001), { headers: { 'Content-Type': 'image/jpeg' } });
    return new Response('nope', { status: 404 });
  };
  return { calls, fetchImpl };
}

function memoryCache() {
  const store = new Map();
  return {
    store,
    match: async (req) => store.get(req.url)?.clone(),
    put: async (req, res) => { store.set(req.url, res); },
  };
}

async function img(env, target, { cookie, net, cache } = {}) {
  const headers = cookie ? { Cookie: cookie } : {};
  const req = new Request(`http://compost.test/img?u=${encodeURIComponent(target)}`, { headers });
  return handle(req, env, { img: { fetchImpl: net.fetchImpl, cache } });
}

test('an authenticated API answer sets the image cookie, once', async () => {
  const app = makeApp();
  const req = (cookie) => new Request('http://compost.test/api/items', { headers: { 'X-Passcode': PASSCODE, ...(cookie && { Cookie: cookie }) } });
  const res = await handle(req(), app.env, { now: T0 });
  const cookie = res.headers.get('Set-Cookie');
  const token = await imgToken(PASSCODE);
  assert.match(cookie, new RegExp(`^compost_img=${token};`));
  for (const part of ['Path=/img', 'Secure', 'HttpOnly', 'SameSite=Strict', 'Max-Age=']) assert.ok(cookie.includes(part), part);
  const again = await handle(req(`compost_img=${token}`), app.env, { now: T0 });
  assert.equal(again.headers.get('Set-Cookie'), null);
  const wrong = await handle(new Request('http://compost.test/api/items', { headers: { 'X-Passcode': 'nope' } }), app.env);
  assert.equal(wrong.headers.get('Set-Cookie'), null);
});

test('/img needs the cookie, proxies only images, and caches them', async () => {
  const { env } = makeApp();
  const cookie = `compost_img=${await imgToken(PASSCODE)}`;
  const net = fakeNetwork();
  const cache = memoryCache();

  const noCookie = await img(env, 'https://cdn.test/pic.png', { net, cache });
  assert.equal(noCookie.status, 404, 'no cookie');
  assert.equal(noCookie.headers.get('Cache-Control'), 'no-store');
  assert.equal((await img(env, 'https://cdn.test/pic.png', { cookie: 'compost_img=bad', net, cache })).status, 404);
  assert.equal(net.calls.length, 0);

  const res = await img(env, 'https://cdn.test/pic.png', { cookie, net, cache });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'image/png');
  assert.match(res.headers.get('Content-Security-Policy'), /sandbox/);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), PNG);

  const cached = await img(env, 'https://cdn.test/pic.png', { cookie, net, cache });
  assert.equal(cached.status, 200);
  assert.equal(net.calls.length, 1, 'second request came from the cache');

  assert.equal((await img(env, 'https://cdn.test/page.html', { cookie, net, cache })).status, 404, 'not an image');
  assert.equal((await img(env, 'https://cdn.test/huge.jpg', { cookie, net, cache })).status, 404, 'over 2MB');
  const missing = await img(env, 'https://cdn.test/missing.png', { cookie, net, cache });
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('Cache-Control'), /max-age=3600/, 'a broken image is skipped for a while');
  assert.equal((await img(env, 'file:///etc/passwd', { cookie, net, cache })).status, 404);
  assert.equal((await img(env, 'not a url', { cookie, net, cache })).status, 404);
  assert.equal(cache.store.size, 1);
});
