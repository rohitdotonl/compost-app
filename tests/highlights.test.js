// Phase 5: highlights, the one-star rule, highlights earning the Vault, and
// the text-quote helpers that find a highlight again in the article.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAY, LIFESPAN, MIN_VAULT_FOR_DAILY, UNDO_WINDOW, HEAP_KEEP } from '../src/rules.js';
import { makeApp, T0 } from './helpers.js';
import { buildIndex, describe, findQuote } from '../public/highlights.js';
import { finishThreshold, hasFinished, stackEdges } from '../public/finish.js';
import { obsidianNote, vaultMarkdown } from '../public/export.js';

const URL_A = 'https://example.com/a';
const URL_B = 'https://example.com/b';

async function saved(app, url = URL_A, now = T0) {
  return (await app.save(url, { now })).data.item.id;
}

const add = (app, id, body, now = T0) => app.call('POST', `/api/items/${id}/highlights`, body, { now });
const quote = (q, prefix = '', suffix = '') => ({ quote: q, prefix, suffix });
const rows = (app, id) => app.db.sqlite.prepare(`SELECT * FROM highlights WHERE item_id = ? ORDER BY id`).all(id);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

test('create, list, note and delete a highlight', async () => {
  const app = makeApp();
  const id = await saved(app);
  const created = await add(app, id, { quote: '  Attention   is finite. ', prefix: 'the reason: ', suffix: ' And promises', note: 'yes' });
  assert.equal(created.status, 201);
  assert.equal(created.data.count, 1);
  const h = created.data.highlight;
  assert.equal(h.quote, 'Attention is finite.');
  assert.equal(h.prefix, 'the reason: ');
  assert.equal(h.suffix, ' And promises');
  assert.equal(h.note, 'yes');
  assert.equal(h.starred, 0);
  assert.equal(h.created_at, T0);

  const listed = await app.call('GET', `/api/items/${id}/highlights`);
  assert.deepEqual(listed.data.highlights.map((x) => x.id), [h.id]);

  const noted = await app.call('POST', `/api/highlights/${h.id}`, { note: '  rewritten  ' });
  assert.equal(noted.data.highlight.note, 'rewritten');
  const cleared = await app.call('POST', `/api/highlights/${h.id}`, { note: '' });
  assert.equal(cleared.data.highlight.note, null);

  const gone = await app.call('POST', `/api/highlights/${h.id}/delete`, {});
  assert.deepEqual(gone.data, { ok: true, count: 0 });
  assert.equal((await app.call('POST', `/api/highlights/${h.id}/delete`, {})).status, 404);
});

test('a highlight needs words and a live item', async () => {
  const app = makeApp();
  const id = await saved(app);
  assert.equal((await add(app, id, { quote: '   ' })).status, 400);
  assert.equal((await add(app, 999, quote('x'))).status, 404);
  await app.call('POST', `/api/items/${id}/toss`, {});
  assert.equal((await add(app, id, quote('x'))).status, 404);
  assert.equal((await app.call('GET', `/api/items/${id}/highlights`)).status, 404);
});

test('long context is cut to the part next to the quote', async () => {
  const app = makeApp();
  const id = await saved(app);
  const { data } = await add(app, id, { quote: 'q', prefix: 'a'.repeat(100) + 'END', suffix: 'START' + 'b'.repeat(100) });
  assert.ok(data.highlight.prefix.endsWith('END') && data.highlight.prefix.length === 64);
  assert.ok(data.highlight.suffix.startsWith('START') && data.highlight.suffix.length === 64);
});

test('starring one highlight clears the star on the others of that article only', async () => {
  const app = makeApp();
  const a = await saved(app, URL_A);
  const b = await saved(app, URL_B);
  const [h1, h2] = [(await add(app, a, quote('one'))).data.highlight, (await add(app, a, quote('two'))).data.highlight];
  const other = (await add(app, b, quote('elsewhere'))).data.highlight;
  await app.call('POST', `/api/highlights/${other.id}`, { starred: true });
  await app.call('POST', `/api/highlights/${h1.id}`, { starred: true });
  let r = await app.call('POST', `/api/highlights/${h2.id}`, { starred: true });
  assert.equal(r.data.highlight.starred, 1);
  assert.deepEqual(rows(app, a).map((x) => x.starred), [0, 1]);
  assert.deepEqual(rows(app, b).map((x) => x.starred), [1]);
  r = await app.call('POST', `/api/highlights/${h2.id}`, { starred: false });
  assert.deepEqual(rows(app, a).map((x) => x.starred), [0, 0]);
  assert.equal((await app.call('POST', `/api/highlights/${h2.id}`, {})).status, 400);
});

test('GET /api/items carries a highlight count on rack and Vault items', async () => {
  const app = makeApp();
  const a = await saved(app, URL_A);
  const b = await saved(app, URL_B);
  await add(app, a, quote('one'));
  await add(app, a, quote('two'));
  await app.call('POST', `/api/items/${b}/done`, { takeaway: 'kept' });
  await add(app, b, quote('after done'));
  const data = await app.list();
  assert.equal(data.rack.find((i) => i.id === a).highlights, 2);
  assert.equal(data.vault.find((i) => i.id === b).highlights, 1);
  // The export list: Vault highlights only.
  const all = await app.call('GET', '/api/highlights');
  assert.deepEqual(all.data.highlights.map((h) => h.quote), ['after done']);
});

// ---------------------------------------------------------------------------
// Highlights earn the Vault; the Heap clears them
// ---------------------------------------------------------------------------

test('an expired article with a highlight is kept in the Vault; one without goes to the Heap', async () => {
  const app = makeApp();
  const a = await saved(app, URL_A);
  const b = await saved(app, URL_B);
  await add(app, a, quote('worth keeping'));
  await app.call('POST', `/api/items/${a}/content`, { html: '<p>Text</p>', text: 'Text', words: 1 });
  const later = T0 + LIFESPAN + 1000;
  const data = await app.list({ now: later });
  const kept = data.vault.find((i) => i.id === a);
  assert.equal(kept.outcome, 'kept');
  assert.equal(kept.ended_at, T0 + LIFESPAN);
  assert.equal(kept.highlights, 1);
  assert.equal(data.heap.find((i) => i.id === b).outcome, 'expired');
  assert.equal(data.rack.length, 0);
  // A kept article keeps its text and highlights, and stays readable.
  const content = await app.call('GET', `/api/items/${a}/content`, undefined, { now: later });
  assert.equal(content.data.status, 'ok');
  assert.equal(rows(app, a).length, 1);
  // ...and is never purged with the Heap.
  const much = await app.list({ now: later + HEAP_KEEP + DAY });
  assert.ok(much.vault.some((i) => i.id === a));
  // Saving the same link again finds it in the Vault.
  assert.equal((await app.save(URL_A, { now: later })).data.status, 'in_vault');
});

test('a toss keeps highlights through its Undo, then they go', async () => {
  const app = makeApp();
  const id = await saved(app);
  await add(app, id, quote('one'));
  await app.call('POST', `/api/items/${id}/toss`, {}, { now: T0 + 1000 });
  await app.call('POST', `/api/items/${id}/untoss`, {}, { now: T0 + 2000 });
  assert.equal(rows(app, id).length, 1);
  await app.call('POST', `/api/items/${id}/toss`, {}, { now: T0 + 3000 });
  await app.list({ now: T0 + 3000 + UNDO_WINDOW + 1 });
  assert.equal(rows(app, id).length, 0);
});

test('dropping or purging an item deletes its highlights', async () => {
  const app = makeApp();
  const id = await saved(app);
  await add(app, id, quote('one'));
  app.db.exec(`UPDATE items SET outcome = 'dropped', ended_at = ${T0} WHERE id = ${id}`);
  assert.equal(rows(app, id).length, 0);
  // Purge: a highlight row left on a Heap item goes with the item.
  app.db.exec(`INSERT INTO highlights (item_id, quote, created_at) VALUES (${id}, 'stray', ${T0})`);
  await app.list({ now: T0 + HEAP_KEEP + DAY });
  assert.equal(app.db.sqlite.prepare(`SELECT COUNT(*) AS n FROM items WHERE id = ?`).get(id).n, 0);
  assert.equal(rows(app, id).length, 0);
});

test('a done article keeps its highlights', async () => {
  const app = makeApp();
  const id = await saved(app);
  await add(app, id, quote('one'));
  await app.call('POST', `/api/items/${id}/done`, { takeaway: 'one' });
  await app.list({ now: T0 + HEAP_KEEP * 2 });
  assert.equal(rows(app, id).length, 1);
});

test('the daily line can be a starred highlight from the Vault', async () => {
  const app = makeApp();
  await app.list();
  const insert = app.db.sqlite.prepare(
    `INSERT INTO items (url, title, site, saved_at, expires_at, outcome, ended_at, takeaway) VALUES (?, ?, 'example.com', ?, ?, 'done', ?, ?)`
  );
  for (let i = 0; i < MIN_VAULT_FOR_DAILY; i++) {
    const ended = T0 - (40 - i) * DAY;
    insert.run(`https://example.com/${i}`, `Title ${i}`, ended - DAY, ended + DAY, ended, `Takeaway ${i}`);
  }
  const h = (await add(app, 1, quote('A line worth coming back to'))).data.highlight;
  await app.call('POST', `/api/highlights/${h.id}`, { starred: true });
  // A starred highlight that is also the takeaway word for word is not a second line.
  const dup = (await add(app, 2, quote('Takeaway 1'))).data.highlight;
  await app.call('POST', `/api/highlights/${dup.id}`, { starred: true });
  await app.call('GET', '/api/daily?day=2026-10-05');
  assert.equal(app.db.sqlite.prepare(`SELECT COUNT(*) AS n FROM reviews WHERE highlight_id = ?`).get(dup.id).n, 0);
  app.db.exec(`UPDATE reviews SET due_at = CASE WHEN highlight_id IS NULL THEN ${T0 + 5 * DAY} ELSE 1 END`);
  const r = (await app.call('GET', '/api/daily?day=2026-10-06', undefined, { now: T0 + DAY })).data.review;
  assert.equal(r.kind, 'highlight');
  assert.equal(r.text, 'A line worth coming back to');
});

// ---------------------------------------------------------------------------
// Text-quote helpers, on a plain array of strings standing in for text nodes
// ---------------------------------------------------------------------------

const NODES = [
  'For about ten years I kept a document. ',
  'It started small',
  '.',
  '\n  ',
  'The list did not fail because I am lazy. It failed because it had ',
  'no edges',
  '. Nothing ever left it.',
];

test('describe → findQuote round-trips a span across several text nodes', () => {
  const index = buildIndex(NODES, [4]);
  // From "small" (node 1) to "did not" (node 4).
  const start = [1, NODES[1].indexOf('small')];
  const end = [4, NODES[4].indexOf(' fail')];
  const q = describe(index, start, end);
  assert.equal(q.quote, 'small. The list did not');
  assert.ok(q.prefix.endsWith('It started '));
  assert.ok(q.suffix.startsWith(' fail because'));
  assert.deepEqual(findQuote(index, q), { start, end });
});

test('a block break with no whitespace node still reads as a space', () => {
  const index = buildIndex(['First paragraph.', 'Second one.'], [1]);
  assert.equal(describe(index, [0, 6], [1, 6]).quote, 'paragraph. Second');
});

test('findQuote ignores whitespace differences, so re-cleaned HTML still matches', () => {
  const recleaned = buildIndex(['For about ten years I kept a document. It started small.', 'The list did not fail because I am lazy.']);
  const found = findQuote(recleaned, quote('small.\n\nThe  list did not'));
  assert.deepEqual(found, { start: [0, 50], end: [1, 16] });
});

test('prefix and suffix choose between repeats of the quote', () => {
  const texts = ['the end. ', 'Read it again. ', 'Then the end. ', 'Read it again.', ' Done.'];
  const index = buildIndex(texts);
  assert.deepEqual(findQuote(index, quote('Read it again.', 'Then the end. ', ' Done.')).start, [3, 0]);
  assert.deepEqual(findQuote(index, quote('Read it again.', 'the end. ', ' Then')).start, [1, 0]);
  // No context: the first one.
  assert.deepEqual(findQuote(index, quote('Read it again.')).start, [1, 0]);
});

test('a quote that is no longer in the text is not found', () => {
  assert.equal(findQuote(buildIndex(NODES), quote('not in this article')), null);
  assert.equal(findQuote(buildIndex(NODES), quote('   ')), null);
  assert.equal(describe(buildIndex(['a  ', ' b']), [0, 1], [1, 1]), null);
});

// ---------------------------------------------------------------------------
// Finish detection, the page stack and the exports
// ---------------------------------------------------------------------------

test('finishing needs the end, an arrival and a plausible share of the reading time', () => {
  assert.equal(finishThreshold(10), 240);
  assert.equal(finishThreshold(null), 20);
  assert.equal(hasFinished({ atEnd: true, arrived: true, activeSeconds: 240, minutes: 10 }), true);
  assert.equal(hasFinished({ atEnd: true, arrived: true, activeSeconds: 30, minutes: 10 }), false); // a flick
  assert.equal(hasFinished({ atEnd: true, arrived: false, activeSeconds: 900, minutes: 10 }), false);
  assert.equal(hasFinished({ atEnd: false, arrived: false, activeSeconds: 900, minutes: 10 }), false);
  assert.equal(hasFinished({ atEnd: true, arrived: true, activeSeconds: 20, minutes: 0 }), true);
});

test('the page stack thins from five edges to one', () => {
  assert.equal(stackEdges(0), 5);
  assert.equal(stackEdges(0.5), 3);
  assert.equal(stackEdges(1), 1);
  assert.equal(stackEdges(2), 1);
});

test('the Markdown and Obsidian exports carry highlights and the kept label', () => {
  const vault = [
    { id: 1, title: 'Kept one', url: 'https://x.test/1', site: 'x.test', outcome: 'kept', ended_at: T0, takeaway: null },
    { id: 2, title: 'Done one', url: 'https://x.test/2', site: 'x.test', outcome: 'done', ended_at: T0, takeaway: 'Ok' },
  ];
  const md = vaultMarkdown(vault, T0, { 1: [{ quote: 'A line', starred: 1, note: 'mine' }] });
  assert.match(md, /x\.test · kept, unfinished/);
  assert.match(md, /- “A line” ★ — mine/);
  assert.match(md, /Finished 2026-10-05/);
  const note = obsidianNote(vault[0], [{ quote: 'A line', starred: 0, note: null }]);
  assert.match(note, /## Highlights\n\n- “A line”\n/);
  assert.doesNotMatch(obsidianNote(vault[1]), /Highlights/);
});
