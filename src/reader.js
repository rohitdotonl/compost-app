// The reader: raw HTML for extraction in the browser, the stored article,
// reading progress and full-text search.
//
// The Worker never parses an article (the free plan allows about 10ms of CPU
// per request). It fetches the raw page for the browser, and stores the clean
// HTML the browser sends back. Contents of an item that leaves for the Heap
// are deleted by a trigger (migrations/0004_reader.sql).
import { json, readBody } from './http.js';
import { cleanText } from './page.js';
import { WORDS_PER_MINUTE } from './rules.js';
import { addSecondsStatement, readingDay } from './weekly.js';

// D1 caps a row at 2MB, so the article and its text stay well under it.
const MAX_HTML_BYTES = 1_200_000;
const MAX_TEXT_BYTES = 600_000;
const SEARCH_LIMIT = 30;

export const routes = [
  ['GET', '/api/items/:id/raw', getRaw],
  ['GET', '/api/items/:id/content', getContent],
  ['POST', '/api/items/:id/content', saveContent],
  ['POST', '/api/items/:id/progress', saveProgress],
  ['GET', '/api/contents', listContents],
  ['GET', '/api/search', search],
];

// Rack and Vault items can be read; the Heap cannot.
const READABLE = `(outcome IS NULL OR outcome IN ('done', 'kept'))`;

function readableItem(db, id) {
  return db.prepare(`SELECT id, url, outcome FROM items WHERE id = ? AND ${READABLE}`).bind(id).first();
}

// GET /api/items/:id/raw → { url, html }, url being the address after redirects.
// 422 { error: 'fetch_failed', reason } when the page can't be had.
async function getRaw({ db, fetchRaw }, { id }) {
  const item = await readableItem(db, id);
  if (!item) return json({ error: 'not_found' }, 404);
  const page = await fetchRaw(item.url);
  if (!page.ok) return json({ error: 'fetch_failed', reason: page.reason }, 422);
  return json({ url: page.url, html: page.html });
}

// GET /api/items/:id/content → the stored article plus where you stopped.
// Until the browser has extracted it, status is 'none' (a 200, so the
// browser console stays quiet) with just the progress.
async function getContent({ db }, { id }) {
  const row = await db
    .prepare(
      `SELECT c.status, c.html, c.words, c.excerpt, c.byline, c.extracted_at, i.progress, i.last_read_at, i.minutes
       FROM items i LEFT JOIN contents c ON c.item_id = i.id WHERE i.id = ? AND ${READABLE.replace(/outcome/g, 'i.outcome')}`
    )
    .bind(id)
    .first();
  if (!row) return json({ error: 'not_found' }, 404);
  if (!row.status) return json({ status: 'none', progress: row.progress, last_read_at: row.last_read_at });
  return json(row);
}

// POST /api/items/:id/content { html, text, words, excerpt, byline }
//                          or { status: 'failed' }
// Stores the browser's extraction and corrects the reading time from the
// real word count. A failed extraction is stored too, so no device retries.
async function saveContent({ db, now, request }, { id }) {
  const item = await readableItem(db, id);
  if (!item) return json({ error: 'not_found' }, 404);
  const body = await readBody(request);

  const html = typeof body.html === 'string' ? body.html : '';
  const text = typeof body.text === 'string' ? body.text : '';
  const tooBig = byteLength(html) > MAX_HTML_BYTES || byteLength(text) > MAX_TEXT_BYTES;
  if (body.status === 'failed' || !html || tooBig) {
    await upsert(db, id, { status: 'failed', extracted_at: now });
    return json({ ok: true, status: 'failed' });
  }

  const words = Math.max(0, Math.round(Number(body.words) || countWords(text)));
  const minutes = minutesFor(words);
  await db.batch([
    upsertStatement(db, id, {
      status: 'ok',
      html,
      text,
      words,
      excerpt: cleanText(String(body.excerpt || '')).slice(0, 500) || null,
      byline: cleanText(String(body.byline || '')).slice(0, 200) || null,
      extracted_at: now,
    }),
    db.prepare(`UPDATE items SET minutes = ? WHERE id = ?`).bind(minutes, id),
  ]);
  return json({ ok: true, status: 'ok', words, minutes });
}

// POST /api/items/:id/progress { progress, seconds?, day? }
// `seconds` is active reading time since the last call; it is added to the
// reading time of `day` (the client's local date) by src/weekly.js.
async function saveProgress({ db, now, request }, { id }) {
  const body = await readBody(request);
  const progress = Number(body.progress);
  if (!Number.isFinite(progress)) return json({ error: 'invalid_progress' }, 400);
  const value = Math.min(1, Math.max(0, progress));
  const res = await db
    .prepare(`UPDATE items SET progress = ?, last_read_at = ? WHERE id = ? AND ${READABLE}`)
    .bind(value, now, id)
    .run();
  if (!res.meta.changes) return json({ error: 'not_found' }, 404);
  const add = addSecondsStatement(db, readingDay(body.day, now), body.seconds);
  if (add) await add.run();
  return json({ ok: true, progress: value, last_read_at: now });
}

// GET /api/contents → { contents: [{ id, status, words }] } for the rack,
// so the app knows which articles still need extracting in the background.
async function listContents({ db }) {
  const { results } = await db
    .prepare(
      `SELECT c.item_id AS id, c.status, c.words FROM contents c
       JOIN items i ON i.id = c.item_id WHERE i.outcome IS NULL`
    )
    .all();
  return json({ contents: results });
}

// GET /api/search?q=… → { results: [{ id, in: 'rack' | 'vault', snippet }] }
// Full-text search over title, article text and takeaway, best match first.
// `snippet` is HTML-escaped text with the matched words in <mark>.
async function search({ db, url }) {
  const match = ftsQuery(url.searchParams.get('q'));
  if (!match) return json({ results: [] });
  const { results } = await db
    .prepare(
      `SELECT i.id, i.outcome, snippet(search, -1, char(2), char(3), '…', 12) AS snippet
       FROM search JOIN items i ON i.id = search.rowid
       WHERE search MATCH ? AND ${READABLE.replace(/outcome/g, 'i.outcome')}
       ORDER BY rank LIMIT ?`
    )
    .bind(match, SEARCH_LIMIT)
    .all();
  return json({
    results: results.map((r) => ({ id: r.id, in: r.outcome == null ? 'rack' : 'vault', snippet: markSnippet(r.snippet) })),
  });
}

// Plain words become an FTS5 query: every word must appear, the last one as
// a prefix (so results come while typing). Operators in the input are ignored.
export function ftsQuery(q) {
  const words = String(q || '').match(/[\p{L}\p{N}]+/gu);
  if (!words) return null;
  const terms = words.slice(0, 8).map((w) => `"${w}"`);
  terms[terms.length - 1] += '*';
  return terms.join(' ');
}

export function markSnippet(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/\u0002/g, '<mark>').replace(/\u0003/g, '</mark>');
}

export function countWords(text) {
  return String(text).split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

export function minutesFor(words) {
  return words > 0 ? Math.max(1, Math.round(words / WORDS_PER_MINUTE)) : null;
}

const COLUMNS = ['html', 'text', 'words', 'excerpt', 'byline', 'extracted_at', 'status'];

function upsertStatement(db, id, fields) {
  const values = COLUMNS.map((c) => fields[c] ?? null);
  return db
    .prepare(
      `INSERT INTO contents (item_id, ${COLUMNS.join(', ')}) VALUES (?, ${COLUMNS.map(() => '?').join(', ')})
       ON CONFLICT (item_id) DO UPDATE SET ${COLUMNS.map((c) => `${c} = excluded.${c}`).join(', ')}`
    )
    .bind(id, ...values);
}

function upsert(db, id, fields) {
  return upsertStatement(db, id, fields).run();
}

function byteLength(s) {
  return new TextEncoder().encode(s).length;
}
