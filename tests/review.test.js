import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, T0 } from './helpers.js';
import { DAY, MIN_VAULT_FOR_DAILY } from '../src/rules.js';
import { nextInterval, words } from '../src/review.js';

const DAY1 = '2026-10-05';

// Puts `n` finished items with takeaways in the Vault, the first finished
// longest ago (n + 10 days before T0, then one day apart).
function seedVault(app, n, { takeaway = (i) => `Takeaway number ${i}`, site = () => 'example.com', title = (i) => `Title ${i}` } = {}) {
  const insert = app.db.sqlite.prepare(
    `INSERT INTO items (url, title, site, saved_at, expires_at, outcome, ended_at, takeaway)
     VALUES (?, ?, ?, ?, ?, 'done', ?, ?)`
  );
  for (let i = 0; i < n; i++) {
    const ended = T0 - (n + 10 - i) * DAY;
    insert.run(`https://example.com/${i}`, title(i), site(i), ended - DAY, ended + DAY, ended, takeaway(i));
  }
}

async function ready(app) {
  await app.call('GET', '/api/items'); // runs the migrations
}

const daily = (app, day = DAY1, now = T0) => app.call('GET', `/api/daily?day=${day}`, undefined, { now });
const answer = (app, id, a, now = T0) => app.call('POST', `/api/reviews/${id}`, { answer: a }, { now });
const review = (app, id) => app.db.sqlite.prepare(`SELECT * FROM reviews WHERE id = ?`).get(id);

test('no daily line until the Vault holds enough takeaways', async () => {
  const app = makeApp();
  await ready(app);
  seedVault(app, MIN_VAULT_FOR_DAILY - 1);
  assert.deepEqual((await daily(app)).data, { day: DAY1, review: null });
  seedVault(app, 1, { takeaway: () => 'One more', title: () => 'Late' });
  const { data } = await daily(app);
  assert.ok(data.review);
  assert.equal(data.review.kind, 'takeaway');
});

test('an invalid day is refused', async () => {
  const app = makeApp();
  assert.equal((await app.call('GET', '/api/daily?day=today')).status, 400);
});

test('the daily pick is the most overdue line and stays the same all day', async () => {
  const app = makeApp();
  await ready(app);
  seedVault(app, 25);
  const first = (await daily(app)).data.review;
  assert.equal(first.text, 'Takeaway number 0'); // finished longest ago
  assert.equal(first.title, 'Title 0');
  assert.equal(first.answered, false);
  const again = (await daily(app, DAY1, T0 + 5 * 3600e3)).data.review;
  assert.equal(again.id, first.id);
  // Every Vault line got a review row, once.
  await daily(app, '2026-10-06', T0 + DAY);
  assert.equal(app.db.sqlite.prepare(`SELECT COUNT(*) AS n FROM reviews`).get().n, 25);
  // The next day moves on to the next most overdue.
  const next = (await daily(app, '2026-10-06', T0 + DAY)).data.review;
  assert.equal(next.text, 'Takeaway number 1');
});

test('with nothing due, an older line not shown lately comes back', async () => {
  const app = makeApp();
  await ready(app);
  seedVault(app, 20);
  await daily(app); // seeds the review rows
  app.db.exec(`UPDATE reviews SET due_at = ${T0 + 100 * DAY}, last_shown_at = NULL`);
  const { data } = await daily(app, '2026-10-06', T0 + DAY);
  assert.ok(data.review);
  // All shown recently and none due: nothing.
  app.db.exec(`UPDATE reviews SET due_at = ${T0 + 100 * DAY}, last_shown_at = ${T0 + DAY}`);
  assert.equal((await daily(app, '2026-10-07', T0 + 2 * DAY)).data.review, null);
});

test('"Still useful" steps the interval out and stays at the last step', async () => {
  assert.deepEqual([1, 7, 30, 90, 180].map(nextInterval), [7, 30, 90, 180, 180]);
  const app = makeApp();
  await ready(app);
  seedVault(app, 20);
  const { id } = (await daily(app)).data.review;
  assert.equal((await answer(app, id, 'keep')).status, 200);
  assert.equal(review(app, id).interval_days, 7);
  assert.equal(review(app, id).due_at, T0 + 7 * DAY);
  await answer(app, id, 'keep');
  assert.equal(review(app, id).interval_days, 30);
  // Today's pick is unchanged, now marked answered.
  const after = (await daily(app)).data.review;
  assert.equal(after.id, id);
  assert.equal(after.answered, true);
  assert.equal((await answer(app, id, 'maybe')).status, 400);
  assert.equal((await answer(app, 9999, 'keep')).status, 404);
});

test('"Let it go" stops a line coming back but keeps the item', async () => {
  const app = makeApp();
  await ready(app);
  seedVault(app, 20);
  const { id, item_id } = (await daily(app)).data.review;
  await answer(app, id, 'retire');
  assert.equal(review(app, id).retired, 1);
  app.db.exec(`UPDATE reviews SET due_at = 0 WHERE id = ${id}`);
  for (let d = 1; d <= 5; d++) {
    const r = (await daily(app, `2026-10-${String(5 + d).padStart(2, '0')}`, T0 + d * DAY)).data.review;
    assert.notEqual(r.id, id);
  }
  const { vault } = await app.list();
  assert.ok(vault.some((i) => i.id === item_id));
});

test('a takeaway can be rewritten, only for Vault items', async () => {
  const app = makeApp();
  await app.save('https://example.com/a');
  const rackId = (await app.list()).rack[0].id;
  assert.equal((await app.call('POST', `/api/items/${rackId}/takeaway`, { takeaway: 'Nope' })).status, 404);
  await app.call('POST', `/api/items/${rackId}/done`, { takeaway: 'First' });
  const res = await app.call('POST', `/api/items/${rackId}/takeaway`, { takeaway: '  Second   thought ' });
  assert.equal(res.status, 200);
  assert.equal(res.data.item.takeaway, 'Second thought');
  const cleared = await app.call('POST', `/api/items/${rackId}/takeaway`, { takeaway: '' });
  assert.equal(cleared.data.item.takeaway, null);
  await app.save('https://example.com/b');
  const b = (await app.list()).rack[0].id;
  await app.call('POST', `/api/items/${b}/toss`);
  assert.equal((await app.call('POST', `/api/items/${b}/takeaway`, { takeaway: 'Heap' })).status, 404);
});

test('the daily line follows an edited takeaway', async () => {
  const app = makeApp();
  await ready(app);
  seedVault(app, 20);
  const { item_id } = (await daily(app)).data.review;
  await app.call('POST', `/api/items/${item_id}/takeaway`, { takeaway: 'Rewritten' });
  assert.equal((await daily(app)).data.review.text, 'Rewritten');
});

test('a starred highlight is shown as its quote (Phase 5 highlights table)', async () => {
  const app = makeApp();
  await ready(app);
  seedVault(app, 20);
  // A highlight on a non-Vault item would not count; this one is on the oldest Vault item.
  app.db.exec(`INSERT INTO highlights (item_id, quote, starred, created_at) VALUES (1, 'A starred quote', 1, ${T0})`);
  await daily(app);
  app.db.exec(`UPDATE reviews SET due_at = CASE WHEN highlight_id IS NULL THEN ${T0} ELSE 1 END`);
  const r = (await daily(app, '2026-10-06', T0 + DAY)).data.review;
  assert.equal(r.kind, 'highlight');
  assert.equal(r.text, 'A starred quote');
});

test('related: same site or two shared words, up to three, never itself', async () => {
  const app = makeApp();
  await ready(app);
  const rows = [
    ['Gardening in winter', 'Compost keeps soil warm through winter', 'a.test'],
    ['Soil science', 'Warm soil holds more life', 'b.test'],         // soil + warm
    ['Another from a.test', 'Unrelated words entirely', 'a.test'],    // same site
    ['Cooking pasta', 'Salt the water generously', 'c.test'],         // nothing
    ['Winter roads', 'Gritting matters in winter', 'd.test'],         // only one word
  ];
  seedVault(app, rows.length, { title: (i) => rows[i][0], takeaway: (i) => rows[i][1], site: (i) => rows[i][2] });
  const { status, data } = await app.call('GET', '/api/items/1/related');
  assert.equal(status, 200);
  assert.deepEqual(data.items.map((i) => i.title), ['Soil science', 'Another from a.test']);
  assert.ok(!words('this that with from about').size);
  assert.equal((await app.call('GET', '/api/items/999/related')).status, 404);
});
