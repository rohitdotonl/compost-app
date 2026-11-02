// Rack, Vault and Heap: listing, saving and the four actions on a rack item.
// Every action answers with the changed item and the slot count, so the app
// can update one row instead of refetching the whole list.
import { json, readBody } from './http.js';
import { cleanText, normaliseUrl } from './page.js';
import { EXTENSION, INTENTS, LIFESPAN, RULES, SLOT_LIMIT, UNDO_WINDOW } from './rules.js';

export const routes = [
  ['GET', '/api/items', listItems],
  ['POST', '/api/items', saveItem],
  ['GET', '/api/lookup', lookup],
  ['POST', '/api/items/:id/intent', setIntent],
  ['POST', '/api/items/:id/done', markDone],
  ['POST', '/api/items/:id/toss', toss],
  ['POST', '/api/items/:id/untoss', untoss],
  ['POST', '/api/items/:id/extend', extend],
  ['POST', '/api/items/:id/note', setNote],
  ['POST', '/api/items/:id/refresh', refresh],
];

const NOTE_MAX = 200;

// Rack and Vault rows carry `highlights`, their highlight count (Phase 5).
const HIGHLIGHTS = `(SELECT COUNT(*) FROM highlights h WHERE h.item_id = items.id) AS highlights`;

async function listItems({ db, now }) {
  const [rack, vault, heap] = await db.batch([
    db.prepare(`SELECT *, ${HIGHLIGHTS} FROM items WHERE outcome IS NULL ORDER BY expires_at ASC, id ASC`),
    // 'kept': expired with a highlight, shown as "kept, unfinished" (Phase 5).
    db.prepare(`SELECT *, ${HIGHLIGHTS} FROM items WHERE outcome IN ('done', 'kept') ORDER BY ended_at DESC, id DESC`),
    db.prepare(
      `SELECT id, url, title, site, outcome, ended_at FROM items
       WHERE outcome IN ('tossed', 'dropped', 'expired') ORDER BY ended_at DESC, id DESC`
    ),
  ]);
  return json({ now, rules: RULES, rack: rack.results, vault: vault.results, heap: heap.results });
}

// GET /api/lookup?url=…  → { status: 'in_rack' | 'in_vault' | 'new', id? }
// For the browser extension's "already saved" mark.
async function lookup({ db, url }) {
  const target = normaliseUrl(url.searchParams.get('url'));
  if (!target) return json({ status: 'invalid_url' }, 400);
  const row = await findSaved(db, target);
  if (!row) return json({ status: 'new' });
  return json({ status: row.outcome == null ? 'in_rack' : 'in_vault', id: row.id });
}

// The rack copy wins over a vault copy when both exist.
function findSaved(db, url) {
  return db
    .prepare(
      `SELECT id, outcome FROM items WHERE url = ? AND (outcome IS NULL OR outcome IN ('done', 'kept'))
       ORDER BY outcome IS NULL DESC LIMIT 1`
    )
    .bind(url)
    .first();
}

// POST /api/items  { url, dropId?, title?, note? }
// `title` is an optional hint (from the share sheet) used only when the page
// itself can't be fetched. `note` is the saver's one-line "why"; sent again
// for a URL already in the rack, it sets the note on that item (the Chrome
// extension saves first and sends the note in a second call).
async function saveItem({ db, now, request, fetchPage }) {
  const body = await readBody(request);
  const url = normaliseUrl(body.url);
  if (!url) return json({ status: 'invalid_url' }, 400);
  const note = cleanNote(body.note);

  const existing = await findSaved(db, url);
  if (existing) {
    if (existing.outcome != null) return json({ status: 'in_vault', id: existing.id });
    if (note) await db.prepare(`UPDATE items SET note = ? WHERE id = ?`).bind(note, existing.id).run();
    return json({ status: 'in_rack', id: existing.id });
  }

  let used = await rackCount(db);
  const dropId = body.dropId == null ? null : Number(body.dropId);
  if (used >= SLOT_LIMIT && dropId == null) {
    return json({ status: 'full', used, limit: SLOT_LIMIT, rack: await rackList(db) }, 409);
  }

  const page = await fetchPage(url);
  const site = new URL(url).hostname.replace(/^www\./, '');
  const title = page.title || cleanText(body.title || '').slice(0, 300) || url;
  const expiresAt = now + LIFESPAN;

  const statements = [];
  if (used >= SLOT_LIMIT) {
    statements.push(
      db.prepare(`UPDATE items SET outcome = 'dropped', ended_at = ? WHERE id = ? AND outcome IS NULL`)
        .bind(now, dropId)
    );
  }
  // The count check is part of the insert, so the slot limit holds even if
  // two saves race each other.
  statements.push(
    db.prepare(
      `INSERT INTO items (url, title, site, minutes, saved_at, expires_at,
                          description, image_url, favicon_url, author, lang, note)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM items WHERE outcome IS NULL) < ?`
    ).bind(url, title, site, page.minutes ?? null, now, expiresAt, ...details(page), note, SLOT_LIMIT)
  );

  let results;
  try {
    results = await db.batch(statements);
  } catch (err) {
    // The unique index caught a save of the same URL that landed meanwhile.
    if (isUniqueError(err)) return json({ status: 'in_rack' });
    throw err;
  }

  // D1 counts rows written by triggers too (the search index, Phase 4), so
  // "at least one" rather than "exactly one".
  const inserted = results[results.length - 1].meta.changes >= 1;
  if (!inserted) {
    // The drop target was invalid, or the rack filled up meanwhile.
    used = await rackCount(db);
    return json({ status: 'full', used, limit: SLOT_LIMIT, rack: await rackList(db) }, 409);
  }

  const item = await db.prepare(`SELECT * FROM items WHERE url = ? AND outcome IS NULL`).bind(url).first();
  return json({ status: 'saved', item, used: await rackCount(db), limit: SLOT_LIMIT }, 201);
}

async function setIntent({ db, request }, { id }) {
  const body = await readBody(request);
  const intent = body.intent == null ? null : String(body.intent);
  if (intent !== null && !INTENTS.includes(intent)) return json({ error: 'invalid_intent' }, 400);
  const res = await db
    .prepare(`UPDATE items SET intent = ? WHERE id = ? AND outcome IS NULL`)
    .bind(intent, id)
    .run();
  if (!res.meta.changes) return json({ error: 'not_in_rack' }, 404);
  return changed(db, id);
}

async function markDone({ db, now, request }, { id }) {
  const body = await readBody(request);
  const takeaway = cleanText(body.takeaway || '').slice(0, 500) || null;
  const res = await db
    .prepare(`UPDATE items SET outcome = 'done', ended_at = ?, takeaway = ? WHERE id = ? AND outcome IS NULL`)
    .bind(now, takeaway, id)
    .run();
  if (!res.meta.changes) return json({ error: 'not_in_rack' }, 404);
  return changed(db, id);
}

async function toss({ db, now }, { id }) {
  const res = await db
    .prepare(`UPDATE items SET outcome = 'tossed', ended_at = ? WHERE id = ? AND outcome IS NULL`)
    .bind(now, id)
    .run();
  if (!res.meta.changes) return json({ error: 'not_in_rack' }, 404);
  return changed(db, id);
}

// Reverses a toss for the Undo in the status line. Only within UNDO_WINDOW of
// the toss, only while a slot is free. This is not a Heap restore: the Heap
// has none.
async function untoss({ db, now }, { id }) {
  let res;
  try {
    res = await db
      .prepare(
        `UPDATE items SET outcome = NULL, ended_at = NULL
         WHERE id = ? AND outcome = 'tossed' AND ended_at >= ?
           AND (SELECT COUNT(*) FROM items WHERE outcome IS NULL) < ?`
      )
      .bind(id, now - UNDO_WINDOW, SLOT_LIMIT)
      .run();
  } catch (err) {
    // The same URL was saved again in the meantime.
    if (isUniqueError(err)) return json({ error: 'cannot_untoss' }, 409);
    throw err;
  }
  if (!res.meta.changes) return json({ error: 'cannot_untoss' }, 409);
  return changed(db, id);
}

async function extend({ db }, { id }) {
  const res = await db
    .prepare(
      `UPDATE items SET expires_at = expires_at + ?, extended = 1
       WHERE id = ? AND outcome IS NULL AND extended = 0`
    )
    .bind(EXTENSION, id)
    .run();
  if (!res.meta.changes) return json({ error: 'cannot_extend' }, 409);
  return changed(db, id);
}

// POST /api/items/:id/note  { note }: an empty note clears it.
async function setNote({ db, request }, { id }) {
  const body = await readBody(request);
  const res = await db
    .prepare(`UPDATE items SET note = ? WHERE id = ? AND outcome IS NULL`)
    .bind(cleanNote(body.note), id)
    .run();
  if (!res.meta.changes) return json({ error: 'not_in_rack' }, 404);
  return changed(db, id);
}

// POST /api/items/:id/refresh: fetches the page again, for a row that came
// in bare. What the fetch can't find keeps its old value.
async function refresh({ db, fetchPage }, { id }) {
  const row = await db.prepare(`SELECT url FROM items WHERE id = ? AND outcome IS NULL`).bind(id).first();
  if (!row) return json({ error: 'not_in_rack' }, 404);
  const page = await fetchPage(row.url);
  await db
    .prepare(
      `UPDATE items SET title = COALESCE(?, title), minutes = COALESCE(?, minutes),
         description = COALESCE(?, description), image_url = COALESCE(?, image_url),
         favicon_url = COALESCE(?, favicon_url), author = COALESCE(?, author), lang = COALESCE(?, lang)
       WHERE id = ? AND outcome IS NULL`
    )
    .bind(page.title || null, page.minutes ?? null, ...details(page), id)
    .run();
  return changed(db, id);
}

// The page details stored with an item, in column order.
function details(page) {
  return [page.description, page.image, page.favicon, page.author, page.lang].map((v) => v || null);
}

function cleanNote(value) {
  return typeof value === 'string' ? cleanText(value).slice(0, NOTE_MAX) || null : null;
}

// The answer to every action: the item as it now is, plus the slot count.
async function changed(db, id) {
  const [item, count] = await db.batch([
    db.prepare(`SELECT * FROM items WHERE id = ?`).bind(id),
    db.prepare(`SELECT COUNT(*) AS n FROM items WHERE outcome IS NULL`),
  ]);
  return json({ ok: true, item: item.results[0], used: count.results[0].n, limit: SLOT_LIMIT });
}

async function rackCount(db) {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM items WHERE outcome IS NULL`).first();
  return row.n;
}

async function rackList(db) {
  const { results } = await db
    .prepare(`SELECT id, url, title, site, expires_at FROM items WHERE outcome IS NULL ORDER BY expires_at ASC, id ASC`)
    .all();
  return results;
}

function isUniqueError(err) {
  return /UNIQUE/i.test(String(err && err.message));
}
