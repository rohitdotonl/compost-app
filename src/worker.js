// Compost: one Worker serving the app, a tiny API and a D1 database.
// Static files in ./public are served by Workers Static Assets before this
// code runs, so fetch() only sees requests that didn't match a file.

import SCHEMA from '../schema.sql';

// ---------------------------------------------------------------------------
// The rules. These are the product: change them here, deliberately.
// ---------------------------------------------------------------------------
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const SLOT_LIMIT = 10;           // articles the rack can hold
const LIFESPAN = 7 * DAY;        // time from saving to expiry
const EXTENSION = 48 * HOUR;     // one extension per article
const HEAP_KEEP = 30 * DAY;      // heap items are purged after this
const WORDS_PER_MINUTE = 230;    // for the reading-time estimate
const FETCH_TIMEOUT = 5000;      // ms to wait for a page's title
const INTENTS = ['tonight', 'commute', 'weekend'];

// Query parameters that only track where a click came from.
const TRACKING_PARAMS = [
  /^utm_/i, /^fbclid$/i, /^gclid$/i, /^dclid$/i, /^gbraid$/i, /^wbraid$/i,
  /^msclkid$/i, /^yclid$/i, /^twclid$/i, /^igshid$/i, /^mc_cid$/i, /^mc_eid$/i,
  /^_ga$/i, /^_gl$/i, /^_hsenc$/i, /^_hsmi$/i, /^mkt_tok$/i, /^vero_id$/i,
  /^oly_anon_id$/i, /^oly_enc_id$/i, /^wt_mc$/i, /^ref_src$/i, /^ref_url$/i,
];

// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    try {
      return await handleApi(request, env, url);
    } catch (err) {
      console.error(err);
      return json({ error: 'server_error' }, 500);
    }
  },
};

async function handleApi(request, env, url) {
  if (!env.PASSCODE) return json({ error: 'passcode_not_set' }, 500);
  if (!safeEqual(request.headers.get('X-Passcode') || '', env.PASSCODE)) {
    return json({ error: 'unauthorized' }, 401);
  }

  const db = env.DB;
  const now = Date.now();
  await ensureSchema(db);
  await sweep(db, now);

  const path = url.pathname;
  const method = request.method;

  if (path === '/api/items') {
    if (method === 'GET') return listItems(db, now);
    if (method === 'POST') return saveItem(db, now, await readBody(request));
    return json({ error: 'method_not_allowed' }, 405);
  }

  const match = path.match(/^\/api\/items\/(\d+)\/(intent|done|toss|extend)$/);
  if (match && method === 'POST') {
    const id = Number(match[1]);
    const body = await readBody(request);
    switch (match[2]) {
      case 'intent': return setIntent(db, id, body);
      case 'done': return markDone(db, now, id, body);
      case 'toss': return toss(db, now, id);
      case 'extend': return extend(db, id);
    }
  }

  return json({ error: 'not_found' }, 404);
}

// Creates the table on first use, so setup needs no separate schema step.
// Runs once per Worker instance; every statement is IF NOT EXISTS.
let schemaReady = null;
function ensureSchema(db) {
  if (!schemaReady) {
    const statements = SCHEMA.replace(/--.*$/gm, '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => db.prepare(s));
    schemaReady = db.batch(statements).catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

// Expiry without a scheduled job: runs at the start of every API call.
async function sweep(db, now) {
  await db.batch([
    db.prepare(
      `UPDATE items SET outcome = 'expired', ended_at = expires_at
       WHERE outcome IS NULL AND expires_at <= ?`
    ).bind(now),
    db.prepare(
      `DELETE FROM items
       WHERE outcome IN ('tossed', 'dropped', 'expired') AND ended_at < ?`
    ).bind(now - HEAP_KEEP),
  ]);
}

async function listItems(db, now) {
  const [rack, vault, heap] = await db.batch([
    db.prepare(`SELECT * FROM items WHERE outcome IS NULL ORDER BY expires_at ASC, id ASC`),
    db.prepare(`SELECT * FROM items WHERE outcome = 'done' ORDER BY ended_at DESC, id DESC`),
    db.prepare(
      `SELECT id, url, title, site, outcome, ended_at FROM items
       WHERE outcome IN ('tossed', 'dropped', 'expired') ORDER BY ended_at DESC, id DESC`
    ),
  ]);
  return json({
    now,
    rules: { slots: SLOT_LIMIT, lifespan: LIFESPAN, extension: EXTENSION, heapKeep: HEAP_KEEP },
    rack: rack.results,
    vault: vault.results,
    heap: heap.results,
  });
}

// POST /api/items  { url, dropId?, title? }
// `title` is an optional hint (from the share sheet) used only when the page
// itself can't be fetched.
async function saveItem(db, now, body) {
  const url = normaliseUrl(body.url);
  if (!url) return json({ status: 'invalid_url' }, 400);

  const existing = await db
    .prepare(
      `SELECT outcome FROM items WHERE url = ? AND (outcome IS NULL OR outcome = 'done')
       ORDER BY outcome IS NULL DESC LIMIT 1`
    )
    .bind(url)
    .first();
  if (existing) {
    return json({ status: existing.outcome === 'done' ? 'in_vault' : 'in_rack' });
  }

  let used = await rackCount(db);
  const dropId = body.dropId == null ? null : Number(body.dropId);
  if (used >= SLOT_LIMIT && dropId == null) {
    return json({ status: 'full', used, limit: SLOT_LIMIT, rack: await rackList(db) }, 409);
  }

  const page = await fetchPageInfo(url);
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
      `INSERT INTO items (url, title, site, minutes, saved_at, expires_at)
       SELECT ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM items WHERE outcome IS NULL) < ?`
    ).bind(url, title, site, page.minutes, now, expiresAt, SLOT_LIMIT)
  );

  let results;
  try {
    results = await db.batch(statements);
  } catch (err) {
    // The unique index caught a save of the same URL that landed meanwhile.
    if (/UNIQUE/i.test(String(err && err.message))) return json({ status: 'in_rack' });
    throw err;
  }

  const inserted = results[results.length - 1].meta.changes === 1;
  if (!inserted) {
    // The drop target was invalid, or the rack filled up meanwhile.
    used = await rackCount(db);
    return json({ status: 'full', used, limit: SLOT_LIMIT, rack: await rackList(db) }, 409);
  }

  const item = await db.prepare(`SELECT * FROM items WHERE url = ? AND outcome IS NULL`).bind(url).first();
  return json({ status: 'saved', item, used: await rackCount(db), limit: SLOT_LIMIT }, 201);
}

async function setIntent(db, id, body) {
  const intent = body.intent == null ? null : String(body.intent);
  if (intent !== null && !INTENTS.includes(intent)) return json({ error: 'invalid_intent' }, 400);
  const res = await db
    .prepare(`UPDATE items SET intent = ? WHERE id = ? AND outcome IS NULL`)
    .bind(intent, id)
    .run();
  if (!res.meta.changes) return json({ error: 'not_in_rack' }, 404);
  return json({ ok: true, intent });
}

async function markDone(db, now, id, body) {
  const takeaway = cleanText(body.takeaway || '').slice(0, 500) || null;
  const res = await db
    .prepare(`UPDATE items SET outcome = 'done', ended_at = ?, takeaway = ? WHERE id = ? AND outcome IS NULL`)
    .bind(now, takeaway, id)
    .run();
  if (!res.meta.changes) return json({ error: 'not_in_rack' }, 404);
  return json({ ok: true, used: await rackCount(db), limit: SLOT_LIMIT });
}

async function toss(db, now, id) {
  const res = await db
    .prepare(`UPDATE items SET outcome = 'tossed', ended_at = ? WHERE id = ? AND outcome IS NULL`)
    .bind(now, id)
    .run();
  if (!res.meta.changes) return json({ error: 'not_in_rack' }, 404);
  return json({ ok: true, used: await rackCount(db), limit: SLOT_LIMIT });
}

async function extend(db, id) {
  const res = await db
    .prepare(
      `UPDATE items SET expires_at = expires_at + ?, extended = 1
       WHERE id = ? AND outcome IS NULL AND extended = 0`
    )
    .bind(EXTENSION, id)
    .run();
  if (!res.meta.changes) return json({ error: 'cannot_extend' }, 409);
  const item = await db.prepare(`SELECT * FROM items WHERE id = ?`).bind(id).first();
  return json({ ok: true, item });
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

// ---------------------------------------------------------------------------
// URLs and page info
// ---------------------------------------------------------------------------

export function normaliseUrl(input) {
  if (typeof input !== 'string') return null;
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.some((re) => re.test(key))) url.searchParams.delete(key);
  }
  let out = url.toString();
  if (out.endsWith('?')) out = out.slice(0, -1);
  return out;
}

// Fetches the page once for its title and a reading-time estimate.
// Any failure just means no title and no estimate.
async function fetchPageInfo(url) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Compost/1.0; personal read-later)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok || !/html/i.test(res.headers.get('content-type') || '')) {
      return { title: null, minutes: null };
    }
    return parsePage(await readCapped(res, 3_000_000));
  } catch {
    return { title: null, minutes: null };
  }
}

async function readCapped(res, maxBytes) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let html = '';
  let bytes = 0;
  while (bytes < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    html += decoder.decode(value, { stream: true });
  }
  reader.cancel().catch(() => {});
  return html;
}

export function parsePage(html) {
  const og =
    html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']*)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*property=["']og:title["']/i);
  const tag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = cleanText(decodeEntities((og && og[1]) || (tag && tag[1]) || '')).slice(0, 300) || null;

  const body = (html.match(/<body[\s\S]*<\/body>/i) || [html])[0];
  const text = decodeEntities(
    body
      .replace(/<(script|style|noscript|svg|template|nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
  );
  const words = text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  const minutes = words >= 150 ? Math.max(1, Math.round(words / WORDS_PER_MINUTE)) : null;
  return { title, minutes };
}

function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', middot: '·' };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    return named[e.toLowerCase()] ?? m;
  });
}

function cleanText(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readBody(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body : {};
  } catch {
    return {};
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// Compares without leaking where the strings differ.
function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < y.length; i++) diff |= (x[i] ?? 0) ^ y[i];
  return diff === 0;
}
