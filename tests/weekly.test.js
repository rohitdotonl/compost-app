import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, T0 } from './helpers.js';
import { S } from '../public/strings.js';

// T0 is Monday 2026-10-05; the Sunday that ends its week is 2026-10-11.
const SUNDAY = '2026-10-11';

async function readingSeconds(app, day) {
  const row = await app.db.prepare(`SELECT seconds FROM reading_days WHERE day = ?`).bind(day).first();
  return row ? row.seconds : 0;
}

async function progress(app, id, body) {
  return app.call('POST', `/api/items/${id}/progress`, { progress: 0.2, ...body });
}

async function seed(app, rows) {
  await app.list(); // runs the migrations
  for (const [day, seconds] of rows) {
    app.db.exec(`INSERT INTO reading_days (day, seconds) VALUES ('${day}', ${seconds})`);
  }
}

test('progress posts add their seconds to the local day they name', async () => {
  const app = makeApp();
  const id = (await app.save('https://example.com/a')).data.item.id;
  await progress(app, id, { seconds: 30, day: '2026-10-05' });
  await progress(app, id, { seconds: 15, day: '2026-10-05' });
  await progress(app, id, { seconds: 20, day: '2026-10-06' });
  assert.equal(await readingSeconds(app, '2026-10-05'), 45);
  assert.equal(await readingSeconds(app, '2026-10-06'), 20);
});

test('each post counts for at most 120 seconds; bogus values count for nothing', async () => {
  const app = makeApp();
  const id = (await app.save('https://example.com/a')).data.item.id;
  await progress(app, id, { seconds: 5000, day: '2026-10-05' });
  await progress(app, id, { seconds: -40, day: '2026-10-05' });
  await progress(app, id, { seconds: 'lots', day: '2026-10-05' });
  assert.equal(await readingSeconds(app, '2026-10-05'), 120);
});

test('without a day, the UTC date counts; an unknown item counts nothing', async () => {
  const app = makeApp();
  const id = (await app.save('https://example.com/a')).data.item.id;
  await progress(app, id, { seconds: 10, day: 'yesterday' });
  assert.equal(await readingSeconds(app, '2026-10-05'), 10);
  assert.equal((await progress(app, 999, { seconds: 50, day: '2026-10-05' })).status, 404);
  assert.equal(await readingSeconds(app, '2026-10-05'), 10);
});

test('the weekly line shows on Sundays only', async () => {
  const app = makeApp();
  await seed(app, [['2026-10-07', 600]]);
  assert.deepEqual((await app.call('GET', `/api/weekly?day=${SUNDAY}`)).data, { show: true, seconds: 600 });
  for (const day of ['2026-10-10', '2026-10-12', '2026-10-07']) {
    assert.deepEqual((await app.call('GET', `/api/weekly?day=${day}`)).data, { show: false, seconds: 0 });
  }
  assert.equal((await app.call('GET', '/api/weekly?day=sunday')).status, 400);
});

test('the week is that Sunday and the six days before it, and needs a minute', async () => {
  const app = makeApp();
  await seed(app, [
    ['2026-10-04', 3000], // the Sunday before: outside
    ['2026-10-05', 20],
    ['2026-10-11', 30],
    ['2026-10-12', 3000], // the Monday after: outside
  ]);
  assert.deepEqual((await app.call('GET', `/api/weekly?day=${SUNDAY}`)).data, { show: false, seconds: 50 });
  await seed(app, [['2026-10-08', 10]]);
  assert.deepEqual((await app.call('GET', `/api/weekly?day=${SUNDAY}`)).data, { show: true, seconds: 60 });
});

test('the line reads "42 min" under an hour and "3 h 10 min" over', () => {
  assert.equal(S.weeklyLine(S.weeklyTime(42)), 'You read for 42 min this week.');
  assert.equal(S.weeklyLine(S.weeklyTime(190)), 'You read for 3 h 10 min this week.');
  assert.equal(S.weeklyTime(120), '2 h');
});
