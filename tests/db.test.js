import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, splitStatements } from '../src/db.js';
import { MIGRATIONS } from '../src/migrations.js';
import { openDatabase } from './d1.js';
import { makeApp } from './helpers.js';


async function applied(db) {
  const { results } = await db.prepare(`SELECT key FROM meta WHERE key LIKE 'migration:%'`).all();
  return results.map((r) => Number(r.key.slice('migration:'.length))).sort((a, b) => a - b);
}
const allNumbers = MIGRATIONS.map(([n]) => n);

test('migrations run on an empty database and record each number', async () => {
  const db = openDatabase();
  await migrate(db);
  assert.deepEqual(await applied(db), allNumbers);
  const tables = (await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all()).results.map((r) => r.name);
  assert.ok(tables.includes('items'));
  assert.ok(tables.includes('meta'));
});

test('migrations are safe on a database that V1 created, and keep its rows', async () => {
  const db = openDatabase();
  // What V1's ensureSchema left behind: the items table, no meta table.
  db.exec(`
    CREATE TABLE items (
      id INTEGER PRIMARY KEY, url TEXT NOT NULL, title TEXT NOT NULL, site TEXT NOT NULL,
      minutes INTEGER, intent TEXT, saved_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      extended INTEGER NOT NULL DEFAULT 0, outcome TEXT, ended_at INTEGER, takeaway TEXT
    );
    CREATE UNIQUE INDEX items_rack_url ON items (url) WHERE outcome IS NULL;
    CREATE INDEX items_outcome ON items (outcome, ended_at);
    INSERT INTO items (url, title, site, saved_at, expires_at) VALUES ('https://old.test/', 'Old', 'old.test', 1, 2);
  `);
  await migrate(db);
  assert.deepEqual(await applied(db), allNumbers);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM items`).first()).n, 1);
});

test('migrations run once per database and skip ones already applied', async () => {
  const db = openDatabase();
  // Pretend every migration but the first already ran: only 0001 runs now.
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)`);
  for (const n of allNumbers.slice(1)) db.exec(`INSERT INTO meta VALUES ('migration:${n}', '1')`);
  await migrate(db);
  await migrate(db);
  assert.deepEqual(await applied(db), allNumbers);
  assert.ok(await db.prepare(`SELECT name FROM sqlite_master WHERE name = 'items'`).first());
});

test('a lower-numbered migration that lands later still runs', async () => {
  const db = openDatabase();
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES ('migration:9999', '1')`);
  await migrate(db);
  assert.deepEqual(await applied(db), [...allNumbers, 9999].sort((a, b) => a - b));
});

test('every API call works on a fresh database (migrations happen on first use)', async () => {
  const app = makeApp();
  const { status } = await app.call('GET', '/api/items');
  assert.equal(status, 200);
  assert.deepEqual(await applied(app.db), allNumbers);
});

test('splitStatements keeps a trigger body together and drops comments', () => {
  const sql = `
    -- a comment; with a semicolon
    CREATE TABLE a (x);
    CREATE TRIGGER t AFTER INSERT ON a BEGIN
      INSERT INTO a VALUES (1);
      DELETE FROM a WHERE x = 2;
    END;
    CREATE INDEX i ON a (x);
  `;
  const parts = splitStatements(sql);
  assert.equal(parts.length, 3);
  assert.match(parts[1], /^CREATE TRIGGER[\s\S]*END$/);
});
