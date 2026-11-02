// The Vault that sticks (Phase 6): one older takeaway or starred highlight a
// day, spaced review behind it, takeaways rewritten later, and related items
// found only in your own Vault.
//
// No scheduled job: the day's pick is made on the first GET /api/daily for
// that date and stored in `daily`, so every device shows the same line.
import { json, readBody } from './http.js';
import { cleanText } from './page.js';
import { DAY, MIN_VAULT_FOR_DAILY, REVIEW_INTERVALS, REVIEW_MIN_AGE, REVIEW_RESHOW } from './rules.js';

export const routes = [
  ['GET', '/api/daily', getDaily],
  ['POST', '/api/reviews/:id', answerReview],
  ['POST', '/api/items/:id/takeaway', editTakeaway],
  ['GET', '/api/items/:id/related', related],
];

// Outcomes that live in the Vault ('kept': expired with a highlight, Phase 5).
const VAULT = `('done', 'kept')`;
const HAS_TAKEAWAY = `i.takeaway IS NOT NULL AND i.takeaway != ''`;

// ---------------------------------------------------------------------------
// GET /api/daily?day=YYYY-MM-DD → { day, review: {...} | null }
// ---------------------------------------------------------------------------

async function getDaily({ db, url, now }) {
  const day = url.searchParams.get('day') || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ error: 'invalid_day' }, 400);
  const highlights = await hasHighlights(db);

  let pinned = await db.prepare(`SELECT review_id, answered_at FROM daily WHERE day = ?`).bind(day).first();
  if (!pinned) {
    const reviewId = await pick(db, now, highlights);
    if (reviewId == null) return json({ day, review: null });
    // A second device may have pinned one meanwhile; the first pin wins.
    await db.prepare(`INSERT OR IGNORE INTO daily (day, review_id) VALUES (?, ?)`).bind(day, reviewId).run();
    pinned = await db.prepare(`SELECT review_id, answered_at FROM daily WHERE day = ?`).bind(day).first();
  }
  const review = await describe(db, pinned.review_id, highlights);
  if (review) review.answered = pinned.answered_at != null;
  return json({ day, review });
}

// Makes sure every Vault line has a review row, then picks one: the most
// overdue, or with nothing due a random older one not shown lately. A shown
// line goes to the back of the queue by its current interval, so an
// unanswered one does not come straight back. Returns the review id or null.
async function pick(db, now, highlights) {
  const count = await db
    .prepare(`SELECT COUNT(*) AS n FROM items i WHERE i.outcome IN ${VAULT} AND ${HAS_TAKEAWAY}`)
    .first();
  if (count.n < MIN_VAULT_FOR_DAILY) return null;

  const seed = [
    db.prepare(
      `INSERT OR IGNORE INTO reviews (item_id, due_at)
       SELECT i.id, COALESCE(i.ended_at, i.saved_at) + ? FROM items i
       WHERE i.outcome IN ${VAULT} AND ${HAS_TAKEAWAY}`
    ).bind(DAY),
  ];
  if (highlights) {
    seed.push(
      db.prepare(
        `INSERT OR IGNORE INTO reviews (item_id, highlight_id, due_at)
         SELECT i.id, h.id, COALESCE(i.ended_at, i.saved_at) + ? FROM highlights h JOIN items i ON i.id = h.item_id
         WHERE h.starred = 1 AND i.outcome IN ${VAULT} AND h.quote != COALESCE(i.takeaway, '')`
      ).bind(DAY)
    );
  }
  await db.batch(seed);

  // A takeaway row needs its takeaway; a highlight row needs a starred highlight.
  const live = highlights
    ? `(r.highlight_id IS NULL AND ${HAS_TAKEAWAY}
        OR r.highlight_id IN (SELECT id FROM highlights WHERE starred = 1))`
    : `r.highlight_id IS NULL AND ${HAS_TAKEAWAY}`;
  const base = `SELECT r.id, r.interval_days FROM reviews r JOIN items i ON i.id = r.item_id
                WHERE r.retired = 0 AND i.outcome IN ${VAULT} AND (${live})`;

  const chosen =
    (await db.prepare(`${base} AND r.due_at <= ? ORDER BY r.due_at ASC, r.id ASC LIMIT 1`).bind(now).first()) ||
    (await db
      .prepare(
        `${base} AND COALESCE(i.ended_at, i.saved_at) < ?
         AND (r.last_shown_at IS NULL OR r.last_shown_at < ?) ORDER BY RANDOM() LIMIT 1`
      )
      .bind(now - REVIEW_MIN_AGE, now - REVIEW_RESHOW)
      .first());
  if (!chosen) return null;

  await db
    .prepare(`UPDATE reviews SET last_shown_at = ?, due_at = ? WHERE id = ?`)
    .bind(now, now + chosen.interval_days * DAY, chosen.id)
    .run();
  return chosen.id;
}

// The card for a review: the takeaway (or the highlight's quote) and its article.
async function describe(db, reviewId, highlights) {
  const row = await db
    .prepare(
      `SELECT r.id, r.item_id, r.highlight_id, i.takeaway, i.title, i.site, i.url, i.ended_at
       FROM reviews r JOIN items i ON i.id = r.item_id WHERE r.id = ?`
    )
    .bind(reviewId)
    .first();
  if (!row) return null;
  let text = row.takeaway;
  let kind = 'takeaway';
  if (row.highlight_id != null && highlights) {
    const h = await db.prepare(`SELECT quote FROM highlights WHERE id = ?`).bind(row.highlight_id).first();
    if (h) {
      text = h.quote;
      kind = 'highlight';
    }
  }
  if (!text) return null;
  return { id: row.id, item_id: row.item_id, text, kind, title: row.title, site: row.site, url: row.url, finished_at: row.ended_at };
}

// The highlights table arrives with Phase 5; until then only takeaways review.
async function hasHighlights(db) {
  const row = await db.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'highlights'`).first();
  return !!row;
}

// ---------------------------------------------------------------------------
// POST /api/reviews/:id { answer: 'keep' | 'retire' }
// "Still useful" steps the interval out; "Let it go" stops it coming back.
// Neither changes today's pick.
// ---------------------------------------------------------------------------

async function answerReview({ db, now, request }, { id }) {
  const { answer } = await readBody(request);
  if (answer !== 'keep' && answer !== 'retire') return json({ error: 'invalid_answer' }, 400);
  const review = await db.prepare(`SELECT interval_days FROM reviews WHERE id = ?`).bind(id).first();
  if (!review) return json({ error: 'not_found' }, 404);

  const update =
    answer === 'keep'
      ? db.prepare(`UPDATE reviews SET interval_days = ?, due_at = ? WHERE id = ?`)
          .bind(nextInterval(review.interval_days), now + nextInterval(review.interval_days) * DAY, id)
      : db.prepare(`UPDATE reviews SET retired = 1 WHERE id = ?`).bind(id);
  await db.batch([
    update,
    db.prepare(`UPDATE daily SET answered_at = ? WHERE review_id = ? AND answered_at IS NULL`).bind(now, id),
  ]);
  return json({ ok: true });
}

export function nextInterval(days) {
  return REVIEW_INTERVALS.find((d) => d > days) ?? REVIEW_INTERVALS[REVIEW_INTERVALS.length - 1];
}

// ---------------------------------------------------------------------------
// POST /api/items/:id/takeaway { takeaway } — Vault items only.
// ---------------------------------------------------------------------------

async function editTakeaway({ db, request }, { id }) {
  const body = await readBody(request);
  const takeaway = cleanText(body.takeaway || '').slice(0, 500) || null;
  const res = await db
    .prepare(`UPDATE items SET takeaway = ? WHERE id = ? AND outcome IN ${VAULT}`)
    .bind(takeaway, id)
    .run();
  if (!res.meta.changes) return json({ error: 'not_in_vault' }, 404);
  const item = await db.prepare(`SELECT * FROM items WHERE id = ?`).bind(id).first();
  return json({ ok: true, item });
}

// ---------------------------------------------------------------------------
// GET /api/items/:id/related → { items: [...] }, up to 3
// Other Vault items from the same site, or sharing two or more words with
// its title and takeaway. Only your own reading: not a recommendation.
// ---------------------------------------------------------------------------

const RELATED_LIMIT = 3;
const STOPWORDS = new Set(
  `about above after again also another back because been before being below between both came come could does
  doing down during each even every from further have having here into just know like made make many more most
  much must need never only other over same should since some such than that their them then there these they
  thing things this those though through under until upon very want were what when where which while will with
  without would your yours http https www html`.split(/\s+/)
);

export function words(text) {
  const out = new Set();
  for (const w of String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (w.length >= 4 && !STOPWORDS.has(w)) out.add(w);
  }
  return out;
}

async function related({ db }, { id }) {
  const item = await db.prepare(`SELECT id, site, title, takeaway FROM items WHERE id = ? AND outcome IN ${VAULT}`).bind(id).first();
  if (!item) return json({ error: 'not_in_vault' }, 404);
  const mine = words(`${item.title} ${item.takeaway || ''}`);
  const { results } = await db
    .prepare(`SELECT id, url, title, site, takeaway, ended_at FROM items WHERE outcome IN ${VAULT} AND id != ?`)
    .bind(id)
    .all();

  const scored = [];
  for (const other of results) {
    let shared = 0;
    for (const w of words(`${other.title} ${other.takeaway || ''}`)) if (mine.has(w)) shared++;
    const sameSite = other.site === item.site;
    if (sameSite || shared >= 2) scored.push({ other, shared, sameSite });
  }
  scored.sort((a, b) => b.shared - a.shared || b.sameSite - a.sameSite || (b.other.ended_at || 0) - (a.other.ended_at || 0));
  const items = scored.slice(0, RELATED_LIMIT).map(({ other }) => ({ id: other.id, url: other.url, title: other.title, site: other.site }));
  return json({ items });
}
