// Highlights (Phase 5): the words you marked in an article, each with an
// optional note, and at most one starred per article as its takeaway.
//
// A highlight is a W3C text quote (quote + prefix + suffix); the browser
// finds it again in the article text (public/highlights.js). Highlights live
// as long as their article is in the Rack or the Vault: a trigger and a sweep
// step remove them when it goes to the Heap (migrations/0005_highlights.sql,
// src/db.js), and an expired article with one is kept in the Vault instead.
import { json, readBody } from './http.js';
import { cleanText } from './page.js';

export const routes = [
  ['GET', '/api/items/:id/highlights', listForItem],
  ['POST', '/api/items/:id/highlights', create],
  ['GET', '/api/highlights', listVault],
  ['POST', '/api/highlights/:id', update],
  ['POST', '/api/highlights/:id/delete', remove],
];

const QUOTE_MAX = 2000;
const CONTEXT_MAX = 64;
const NOTE_MAX = 500;
const PER_ITEM_MAX = 200;
const COLUMNS = `id, item_id, quote, prefix, suffix, note, starred, created_at`;
// Rack and Vault items can carry highlights; the Heap cannot.
const LIVE = `(outcome IS NULL OR outcome IN ('done', 'kept'))`;

function liveItem(db, id) {
  return db.prepare(`SELECT id FROM items WHERE id = ? AND ${LIVE}`).bind(id).first();
}

// The highlight with its item, if that item is still live.
function liveHighlight(db, id) {
  return db
    .prepare(`SELECT h.id, h.item_id FROM highlights h JOIN items i ON i.id = h.item_id WHERE h.id = ? AND ${LIVE.replace(/outcome/g, 'i.outcome')}`)
    .bind(id)
    .first();
}

// GET /api/items/:id/highlights → { highlights: [...] }, oldest first.
async function listForItem({ db }, { id }) {
  if (!(await liveItem(db, id))) return json({ error: 'not_found' }, 404);
  const { results } = await db.prepare(`SELECT ${COLUMNS} FROM highlights WHERE item_id = ? ORDER BY id`).bind(id).all();
  return json({ highlights: results });
}

// GET /api/highlights → every Vault highlight, for the exports. Kept out of
// GET /api/items so the list stays light.
async function listVault({ db }) {
  const { results } = await db
    .prepare(
      `SELECT h.${COLUMNS.split(', ').join(', h.')} FROM highlights h JOIN items i ON i.id = h.item_id
       WHERE i.outcome IN ('done', 'kept') ORDER BY h.item_id, h.id`
    )
    .all();
  return json({ highlights: results });
}

// POST /api/items/:id/highlights { quote, prefix, suffix, note? }
//   → 201 { highlight, count }
async function create({ db, now, request }, { id }) {
  if (!(await liveItem(db, id))) return json({ error: 'not_found' }, 404);
  const body = await readBody(request);
  const quote = collapse(body.quote).slice(0, QUOTE_MAX);
  if (!quote) return json({ error: 'invalid_quote' }, 400);
  const res = await db
    .prepare(
      `INSERT INTO highlights (item_id, quote, prefix, suffix, note, starred, created_at)
       SELECT ?, ?, ?, ?, ?, 0, ? WHERE (SELECT COUNT(*) FROM highlights WHERE item_id = ?) < ?`
    )
    .bind(id, quote, context(body.prefix, 'end'), context(body.suffix, 'start'), cleanNote(body.note), now, id, PER_ITEM_MAX)
    .run();
  if (!res.meta.changes) return json({ error: 'too_many' }, 409);
  const [highlight, count] = await db.batch([
    db.prepare(`SELECT ${COLUMNS} FROM highlights WHERE id = ?`).bind(res.meta.last_row_id),
    db.prepare(`SELECT COUNT(*) AS n FROM highlights WHERE item_id = ?`).bind(id),
  ]);
  return json({ highlight: highlight.results[0], count: count.results[0].n }, 201);
}

// POST /api/highlights/:id { note?, starred? } → { highlight }
// Starring one clears the star on the article's others.
async function update({ db, request }, { id }) {
  const found = await liveHighlight(db, id);
  if (!found) return json({ error: 'not_found' }, 404);
  const body = await readBody(request);
  const statements = [];
  if ('note' in body) statements.push(db.prepare(`UPDATE highlights SET note = ? WHERE id = ?`).bind(cleanNote(body.note), id));
  if ('starred' in body) {
    if (body.starred) {
      statements.push(db.prepare(`UPDATE highlights SET starred = 0 WHERE item_id = ? AND id != ?`).bind(found.item_id, id));
    }
    statements.push(db.prepare(`UPDATE highlights SET starred = ? WHERE id = ?`).bind(body.starred ? 1 : 0, id));
  }
  if (!statements.length) return json({ error: 'nothing_to_change' }, 400);
  statements.push(db.prepare(`SELECT ${COLUMNS} FROM highlights WHERE id = ?`).bind(id));
  const results = await db.batch(statements);
  return json({ highlight: results[results.length - 1].results[0] });
}

// POST /api/highlights/:id/delete → { ok, count }
async function remove({ db }, { id }) {
  const found = await liveHighlight(db, id);
  if (!found) return json({ error: 'not_found' }, 404);
  const [, count] = await db.batch([
    db.prepare(`DELETE FROM highlights WHERE id = ?`).bind(id),
    db.prepare(`SELECT COUNT(*) AS n FROM highlights WHERE item_id = ?`).bind(found.item_id),
  ]);
  return json({ ok: true, count: count.results[0].n });
}

function collapse(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

// Keeps the part of the context next to the quote.
function context(value, keep) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ') : '';
  if (!text) return null;
  return keep === 'end' ? text.slice(-CONTEXT_MAX) : text.slice(0, CONTEXT_MAX);
}

function cleanNote(value) {
  return typeof value === 'string' ? cleanText(value).slice(0, NOTE_MAX) || null : null;
}
