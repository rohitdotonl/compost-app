// Database upkeep: migrations on first use and the expiry sweep on every call.
import { MIGRATIONS } from './migrations.js';
import { HEAP_KEEP, UNDO_WINDOW } from './rules.js';

const META_TABLE = `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`;
const KEY_PREFIX = 'migration:';

// Applies every migration not yet recorded, each as one batch
// (D1 runs a batch as a transaction, so a failure leaves nothing half done).
// Runs once per Worker instance; a failure clears the memo so the next
// request tries again.
const ready = new WeakMap();
export function migrate(db) {
  if (!ready.has(db)) {
    ready.set(
      db,
      runMigrations(db).catch((err) => {
        ready.delete(db);
        throw err;
      })
    );
  }
  return ready.get(db);
}

async function runMigrations(db) {
  await db.prepare(META_TABLE).run();
  // Each migration is recorded on its own, so one that lands after a higher
  // number was applied (phases merged out of order) still runs.
  const { results } = await db.prepare(`SELECT key FROM meta WHERE key LIKE ?`).bind(`${KEY_PREFIX}%`).all();
  const applied = new Set(results.map((r) => Number(r.key.slice(KEY_PREFIX.length))));
  for (const [number, sql] of MIGRATIONS) {
    if (applied.has(number)) continue;
    await db.batch([
      ...splitStatements(sql).map((s) => db.prepare(s)),
      db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).bind(KEY_PREFIX + number, String(Date.now())),
    ]);
  }
}

// One statement per `;`. A CREATE TRIGGER body (BEGIN … END;) stays whole.
export function splitStatements(sql) {
  const out = [];
  let buffer = '';
  for (const part of sql.replace(/--.*$/gm, '').split(';')) {
    buffer += (buffer ? ';' : '') + part;
    const text = buffer.trim();
    if (!text) { buffer = ''; continue; }
    if (/\bCREATE\s+(TEMP(ORARY)?\s+)?TRIGGER\b/i.test(text) && !/\bEND\s*$/i.test(text)) continue;
    out.push(text);
    buffer = '';
  }
  return out;
}

// Expiry without a scheduled job: runs at the start of every API call.
// Each step returns one prepared statement; the steps run as one batch, in
// this order.
export const SWEEP_STEPS = [keepHighlighted, expireRack, purgeHeap, forgetTossedHighlights];

// Phase 5: highlights earn the Vault. An expired article with at least one
// highlight is 'kept' (shown as "kept, unfinished") instead of going to the Heap.
function keepHighlighted(db, now) {
  return db
    .prepare(
      `UPDATE items SET outcome = 'kept', ended_at = expires_at
       WHERE outcome IS NULL AND expires_at <= ? AND EXISTS (SELECT 1 FROM highlights h WHERE h.item_id = items.id)`
    )
    .bind(now);
}

function expireRack(db, now) {
  return db
    .prepare(`UPDATE items SET outcome = 'expired', ended_at = expires_at WHERE outcome IS NULL AND expires_at <= ?`)
    .bind(now);
}

function purgeHeap(db, now) {
  return db
    .prepare(`DELETE FROM items WHERE outcome IN ('tossed', 'dropped', 'expired') AND ended_at < ?`)
    .bind(now - HEAP_KEEP);
}

// A tossed article keeps its highlights only as long as its Undo lasts.
function forgetTossedHighlights(db, now) {
  return db
    .prepare(
      `DELETE FROM highlights WHERE item_id IN
         (SELECT id FROM items WHERE outcome = 'tossed' AND ended_at < ?)`
    )
    .bind(now - UNDO_WINDOW);
}

export function sweep(db, now) {
  return db.batch(SWEEP_STEPS.map((step) => step(db, now)));
}
