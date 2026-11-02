// The rules from the brief's acceptance list, run against the real handler.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAY, EXTENSION, HEAP_KEEP, HOUR, LIFESPAN, SLOT_LIMIT, UNDO_WINDOW } from '../src/rules.js';
import { makeApp, T0 } from './helpers.js';

const link = (n) => `https://example.com/post-${n}`;

async function fillRack(app, count = SLOT_LIMIT) {
  const items = [];
  for (let i = 0; i < count; i++) {
    const { status, data } = await app.save(link(i), { now: T0 + i * 1000 });
    assert.equal(status, 201);
    items.push(data.item);
  }
  return items;
}

test('API calls without the right passcode get 401', async () => {
  const app = makeApp();
  assert.equal((await app.call('GET', '/api/items', undefined, { passcode: 'nope' })).status, 401);
  assert.equal((await app.call('GET', '/api/items', undefined, { passcode: '' })).status, 401);
  assert.equal((await app.call('GET', '/api/items')).status, 200);
});

test('a save answers with the item, the slot count and a title from the page', async () => {
  const app = makeApp();
  const { status, data } = await app.save('https://example.com/a?utm_source=x');
  assert.equal(status, 201);
  assert.equal(data.status, 'saved');
  assert.equal(data.item.url, 'https://example.com/a');
  assert.equal(data.item.title, 'Article A');
  assert.equal(data.item.minutes, 4);
  assert.equal(data.item.site, 'example.com');
  assert.equal(data.item.expires_at, T0 + LIFESPAN);
  assert.deepEqual([data.used, data.limit], [1, SLOT_LIMIT]);
});

test('an unfetchable page uses the title hint, then the URL', async () => {
  const app = makeApp();
  const a = await app.save('https://nowhere.test/x', {}, { title: 'From the share sheet' });
  assert.equal(a.data.item.title, 'From the share sheet');
  const b = await app.save('https://nowhere.test/y');
  assert.equal(b.data.item.title, 'https://nowhere.test/y');
});

test('the same URL twice reports in_rack; a vault copy reports in_vault', async () => {
  const app = makeApp();
  const first = await app.save(link(1));
  assert.deepEqual((await app.save(link(1) + '#top')).data, { status: 'in_rack', id: first.data.item.id });
  await app.call('POST', `/api/items/${first.data.item.id}/done`, {});
  assert.deepEqual((await app.save(link(1))).data, { status: 'in_vault', id: first.data.item.id });
});

test('the 11th save is blocked until one is dropped, even via the API', async () => {
  const app = makeApp();
  const items = await fillRack(app);

  const blocked = await app.save(link(99));
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.status, 'full');
  assert.equal(blocked.data.rack.length, SLOT_LIMIT);
  assert.equal((await app.list()).rack.length, SLOT_LIMIT);

  // A drop id that is not in the rack does not make room either.
  const badDrop = await app.save(link(99), {}, { dropId: 9999 });
  assert.equal(badDrop.status, 409);

  const dropped = await app.save(link(99), {}, { dropId: items[3].id });
  assert.equal(dropped.status, 201);
  const after = await app.list();
  assert.equal(after.rack.length, SLOT_LIMIT);
  assert.ok(!after.rack.some((i) => i.id === items[3].id));
  assert.equal(after.heap.find((i) => i.id === items[3].id).outcome, 'dropped');
});

test('the rack is sorted by expiring soonest', async () => {
  const app = makeApp();
  await app.save(link(1), { now: T0 + DAY });
  await app.save(link(2), { now: T0 });
  await app.save(link(3), { now: T0 + 2 * DAY });
  const { rack } = await app.list({ now: T0 + 2 * DAY });
  assert.deepEqual(rack.map((i) => i.url), [link(2), link(1), link(3)]);
});

test('an article past 7 days leaves the rack and appears in the heap as expired', async () => {
  const app = makeApp();
  const { data } = await app.save(link(1));
  const before = await app.list({ now: T0 + LIFESPAN - 1 });
  assert.equal(before.rack.length, 1);
  const after = await app.list({ now: T0 + LIFESPAN });
  assert.equal(after.rack.length, 0);
  assert.equal(after.heap.length, 1);
  assert.equal(after.heap[0].outcome, 'expired');
  assert.equal(after.heap[0].ended_at, data.item.expires_at);
});

test('+48h works once per article and then is refused', async () => {
  const app = makeApp();
  const { data } = await app.save(link(1));
  const first = await app.call('POST', `/api/items/${data.item.id}/extend`, {});
  assert.equal(first.status, 200);
  assert.equal(first.data.item.expires_at, T0 + LIFESPAN + EXTENSION);
  assert.equal(first.data.item.extended, 1);
  assert.equal(first.data.used, 1);
  const second = await app.call('POST', `/api/items/${data.item.id}/extend`, {});
  assert.equal(second.status, 409);
  assert.equal(second.data.error, 'cannot_extend');
  // The extension really does buy two more days.
  assert.equal((await app.list({ now: T0 + LIFESPAN + EXTENSION - 1 })).rack.length, 1);
  assert.equal((await app.list({ now: T0 + LIFESPAN + EXTENSION })).rack.length, 0);
});

test('done moves to the vault with its takeaway; toss to the heap; both free the slot', async () => {
  const app = makeApp();
  const items = await fillRack(app);
  assert.equal((await app.save(link(99))).status, 409);

  const done = await app.call('POST', `/api/items/${items[0].id}/done`, { takeaway: '  One   line  ' }, { now: T0 + HOUR });
  assert.equal(done.status, 200);
  assert.equal(done.data.item.outcome, 'done');
  assert.equal(done.data.item.takeaway, 'One line');
  assert.equal(done.data.item.ended_at, T0 + HOUR);
  assert.deepEqual([done.data.used, done.data.limit], [SLOT_LIMIT - 1, SLOT_LIMIT]);

  const toss = await app.call('POST', `/api/items/${items[1].id}/toss`, {}, { now: T0 + HOUR });
  assert.equal(toss.data.item.outcome, 'tossed');
  assert.equal(toss.data.used, SLOT_LIMIT - 2);

  const { rack, vault, heap } = await app.list();
  assert.equal(rack.length, SLOT_LIMIT - 2);
  assert.deepEqual(vault.map((i) => i.id), [items[0].id]);
  assert.deepEqual(heap.map((i) => i.id), [items[1].id]);

  // Acting on something that already left the rack is a 404.
  assert.equal((await app.call('POST', `/api/items/${items[0].id}/toss`, {})).status, 404);
  assert.equal((await app.call('POST', `/api/items/${items[1].id}/done`, {})).status, 404);
  // And two slots are free again.
  assert.equal((await app.save(link(99))).status, 201);
});

test('intent is one of the three, or null, and only on rack items', async () => {
  const app = makeApp();
  const { data } = await app.save(link(1));
  const set = await app.call('POST', `/api/items/${data.item.id}/intent`, { intent: 'weekend' });
  assert.equal(set.data.item.intent, 'weekend');
  const cleared = await app.call('POST', `/api/items/${data.item.id}/intent`, { intent: null });
  assert.equal(cleared.data.item.intent, null);
  assert.equal((await app.call('POST', `/api/items/${data.item.id}/intent`, { intent: 'someday' })).status, 400);
  assert.equal((await app.call('POST', `/api/items/4242/intent`, { intent: 'tonight' })).status, 404);
});

test('heap items are gone after 30 days; vault items stay', async () => {
  const app = makeApp();
  const a = await app.save(link(1));
  const b = await app.save(link(2));
  await app.call('POST', `/api/items/${a.data.item.id}/toss`, {}, { now: T0 + HOUR });
  await app.call('POST', `/api/items/${b.data.item.id}/done`, {}, { now: T0 + HOUR });

  const kept = await app.list({ now: T0 + HOUR + HEAP_KEEP });
  assert.equal(kept.heap.length, 1);
  const purged = await app.list({ now: T0 + HOUR + HEAP_KEEP + 1 });
  assert.equal(purged.heap.length, 0);
  assert.equal(purged.vault.length, 1);
  assert.equal((await app.db.prepare(`SELECT COUNT(*) AS n FROM items`).first()).n, 1);
});

test('lookup says in_rack, in_vault or new', async () => {
  const app = makeApp();
  const a = await app.save(link(1));
  const b = await app.save(link(2));
  await app.call('POST', `/api/items/${b.data.item.id}/done`, {});
  const lookup = (url) => app.call('GET', `/api/lookup?url=${encodeURIComponent(url)}`).then((r) => r.data);
  assert.deepEqual(await lookup(link(1) + '?utm_campaign=x'), { status: 'in_rack', id: a.data.item.id });
  assert.deepEqual(await lookup(link(2)), { status: 'in_vault', id: b.data.item.id });
  assert.deepEqual(await lookup(link(3)), { status: 'new' });
  assert.equal((await app.call('GET', '/api/lookup?url=nope')).status, 400);
  assert.equal((await app.call('GET', '/api/lookup')).status, 400);
});

test('untoss works only within the undo window and only for a toss', async () => {
  const app = makeApp();
  const { data } = await app.save(link(1));
  const id = data.item.id;
  const undo = (now) => app.call('POST', `/api/items/${id}/untoss`, {}, { now });

  // Not tossed yet.
  assert.equal((await undo(T0)).status, 409);

  await app.call('POST', `/api/items/${id}/toss`, {}, { now: T0 + HOUR });
  const back = await undo(T0 + HOUR + UNDO_WINDOW);
  assert.equal(back.status, 200);
  assert.equal(back.data.item.outcome, null);
  assert.equal(back.data.item.ended_at, null);
  assert.equal(back.data.item.expires_at, data.item.expires_at);
  assert.equal(back.data.used, 1);
  assert.equal((await app.list()).rack.length, 1);

  // Too late.
  await app.call('POST', `/api/items/${id}/toss`, {}, { now: T0 + 2 * HOUR });
  assert.equal((await undo(T0 + 2 * HOUR + UNDO_WINDOW + 1)).status, 409);
  assert.equal((await app.list()).heap.length, 1);

  // Never for a done or an expired item.
  const other = await app.save(link(2));
  await app.call('POST', `/api/items/${other.data.item.id}/done`, {}, { now: T0 });
  assert.equal((await app.call('POST', `/api/items/${other.data.item.id}/untoss`, {}, { now: T0 })).status, 409);
});

test('untoss needs a free slot', async () => {
  const app = makeApp();
  const items = await fillRack(app);
  await app.call('POST', `/api/items/${items[0].id}/toss`, {}, { now: T0 + HOUR });
  await app.save(link(99), { now: T0 + HOUR });
  const res = await app.call('POST', `/api/items/${items[0].id}/untoss`, {}, { now: T0 + HOUR + 1000 });
  assert.equal(res.status, 409);
  assert.equal((await app.list()).rack.length, SLOT_LIMIT);
});

test('unknown routes and methods answer 404 and 405', async () => {
  const app = makeApp();
  assert.equal((await app.call('GET', '/api/nothing')).status, 404);
  assert.equal((await app.call('DELETE', '/api/items')).status, 405);
  assert.equal((await app.call('POST', '/api/items/abc/done', {})).status, 404);
});
