import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normaliseUrl, parsePage } from '../src/page.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('normaliseUrl strips tracking params and the fragment', () => {
  assert.equal(
    normaliseUrl('https://Example.com/post?utm_source=x&id=7&fbclid=abc#section'),
    'https://example.com/post?id=7'
  );
  assert.equal(normaliseUrl('  https://example.com/post?utm_medium=mail '), 'https://example.com/post');
});

test('normaliseUrl rejects anything that is not http(s)', () => {
  assert.equal(normaliseUrl('ftp://example.com/x'), null);
  assert.equal(normaliseUrl('javascript:alert(1)'), null);
  assert.equal(normaliseUrl('not a url'), null);
  assert.equal(normaliseUrl(42), null);
  assert.equal(normaliseUrl(null), null);
});

test('normaliseUrl keeps meaningful query parameters and order', () => {
  assert.equal(normaliseUrl('https://example.com/?b=2&a=1'), 'https://example.com/?b=2&a=1');
});

test('parsePage prefers og:title, decodes entities, estimates minutes', () => {
  const { title, minutes } = parsePage(fixture('article.html'));
  assert.equal(title, 'Why Slow Reading Wins & What It Costs');
  assert.equal(minutes, 1);
});

test('parsePage falls back to <title> and gives no estimate for short pages', () => {
  const { title, minutes } = parsePage(fixture('bare.html'));
  assert.equal(title, 'Short & sweet');
  assert.equal(minutes, null);
});

test('parsePage copes with pages that have neither', () => {
  assert.deepEqual(parsePage('<p>hi</p>', 'https://example.com/x'), {
    title: null, minutes: null, description: null, image: null,
    favicon: 'https://example.com/favicon.ico', author: null, lang: null,
  });
  assert.equal(parsePage('<p>hi</p>').favicon, null, 'no page URL, no favicon guess');
});

test('parsePage reads og tags, resolving image and icon against the page', () => {
  const page = parsePage(fixture('rich.html'), 'https://fieldnotes.example.org/2026/10/shelf');
  assert.equal(page.title, 'The Quiet Shelf');
  assert.equal(page.description, 'Why a small shelf of books & articles beats an endless queue.');
  assert.equal(page.image, 'https://fieldnotes.example.org/images/shelf.jpg?w=1200&h=630');
  assert.equal(page.favicon, 'https://fieldnotes.example.org/2026/10/favicon-32.png');
  assert.equal(page.author, 'Mira Okafor', 'a profile URL is not a name; meta author is');
  assert.equal(page.lang, 'en-GB');
});

test('parsePage falls back to twitter tags and the apple-touch-icon', () => {
  const page = parsePage(fixture('twitter.html'), 'https://example.net/a/b');
  assert.equal(page.title, 'Le titre');
  assert.equal(page.description, 'Une description courte.');
  assert.equal(page.image, 'https://images.example.net/card.png');
  assert.equal(page.author, 'Jeanne Martin');
  assert.equal(page.lang, 'fr');
  assert.equal(page.favicon, 'https://example.net/favicon.ico');
  const touch = parsePage('<head><link rel="apple-touch-icon-precomposed" href="/t.png"></head>', 'https://x.test/');
  assert.equal(touch.favicon, 'https://x.test/t.png');
});

test('parsePage ignores non-http image links', () => {
  const page = parsePage('<head><meta property="og:image" content="javascript:alert(1)"></head>', 'https://x.test/');
  assert.equal(page.image, null);
});
