// The daily reminder (Phase 8): Web Push, off by default, at most once a day
// and only when something leaves the rack within 24 hours.
//
// The hourly Cron Trigger calls runScheduled(). A push carries no payload:
// the service worker wakes, asks GET /api/digest for the words and shows the
// notification itself. Preferences are rows in meta (see 0008_nudges.sql).
import { migrate, sweep } from './db.js';
import { json, readBody } from './http.js';
import { DAY } from './rules.js';
import { vapidHeaders, vapidKeys } from './vapid.js';
import { S } from '../public/strings.js';

const PUSH_TTL = 12 * 60 * 60; // seconds a push service keeps an undelivered nudge
const MINUTE = 60 * 1000;
const FALLBACK_SUB = 'mailto:compost@localhost.invalid'; // VAPID contact for a non-https dev origin

export const routes = [
  ['GET', '/api/push/key', getKey],
  ['POST', '/api/push/subscribe', subscribe],
  ['POST', '/api/push/unsubscribe', unsubscribe],
  ['GET', '/api/push/status', getStatus],
  ['GET', '/api/digest', getDigest],
];

// GET /api/push/key → { key }: the VAPID public key, base64url.
async function getKey({ db }) {
  const { publicKey } = await vapidKeys(db);
  return json({ key: publicKey });
}

// POST /api/push/subscribe { subscription, hour, tzOffset } → status.
// Also how the hour changes and how the time zone is kept current.
async function subscribe({ db, now, request, url }) {
  const body = await readBody(request);
  const sub = body.subscription || {};
  const hour = Number(body.hour);
  const tz = Number(body.tzOffset);
  if (!isPushEndpoint(sub.endpoint)) return json({ error: 'invalid_subscription' }, 400);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return json({ error: 'invalid_hour' }, 400);
  if (!Number.isInteger(tz) || Math.abs(tz) > 14 * 60) return json({ error: 'invalid_tz' }, 400);

  const keys = sub.keys || {};
  await db.batch([
    db.prepare(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`
    ).bind(sub.endpoint, str(keys.p256dh), str(keys.auth), now),
    ...setMeta(db, { reminder_enabled: '1', reminder_hour: String(hour), tz_offset_minutes: String(tz), app_origin: url.origin }),
  ]);
  return json(await status(db, sub.endpoint));
}

// POST /api/push/unsubscribe { endpoint } → status. The reminder turns off
// once no browser is left to receive it.
async function unsubscribe({ db, request }) {
  const { endpoint } = await readBody(request);
  await db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).bind(str(endpoint)).run();
  const left = await db.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions`).first();
  if (!left.n) await db.batch(setMeta(db, { reminder_enabled: '0' }));
  return json(await status(db, endpoint));
}

// GET /api/push/status?endpoint=… → { enabled, hour, tzOffset, subscribed }
// where subscribed says whether that browser's endpoint is known.
async function getStatus({ db, url }) {
  return json(await status(db, url.searchParams.get('endpoint')));
}

async function status(db, endpoint) {
  const prefs = await readPrefs(db);
  const known = endpoint
    ? await db.prepare(`SELECT 1 AS y FROM push_subscriptions WHERE endpoint = ?`).bind(String(endpoint)).first()
    : null;
  return { enabled: prefs.enabled, hour: prefs.hour, tzOffset: prefs.tz, subscribed: !!known };
}

// GET /api/digest → { text, count }: what the notification says. text is
// null when nothing leaves the rack within 24 hours.
async function getDigest({ db, now }) {
  const prefs = await readPrefs(db);
  return json(await digest(db, now, prefs.tz));
}

export async function digest(db, now, tz = 0) {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n, MIN(expires_at) AS first, MAX(expires_at) AS last FROM items WHERE outcome IS NULL AND expires_at <= ?`)
    .bind(now + DAY)
    .first();
  if (!row.n) return { text: null, count: 0 };
  // The end of the owner's local today, in UTC ms.
  const midnight = Math.floor((now + tz * MINUTE) / DAY) * DAY + DAY - tz * MINUTE;
  const when = row.last < midnight ? 'today' : row.first >= midnight ? 'tomorrow' : 'soon';
  return { text: S.digest(row.n, when), count: row.n };
}

// ---------------------------------------------------------------------------
// The hourly run
// ---------------------------------------------------------------------------

// Sends the day's reminder when the owner's local hour is the chosen one,
// none was sent today and something leaves within 24 hours. `now` and
// `fetch` are injected by the tests. → { sent, reason }
export async function runScheduled(env, { now = Date.now(), fetch = globalThis.fetch } = {}) {
  const db = env.DB;
  await migrate(db);
  await sweep(db, now);

  const prefs = await readPrefs(db);
  if (!prefs.enabled) return { sent: 0, reason: 'off' };
  const local = new Date(now + prefs.tz * MINUTE);
  if (local.getUTCHours() !== prefs.hour) return { sent: 0, reason: 'not_the_hour' };
  const today = local.toISOString().slice(0, 10);
  if (prefs.lastDay === today) return { sent: 0, reason: 'already_sent' };
  const { count } = await digest(db, now, prefs.tz);
  if (!count) return { sent: 0, reason: 'nothing_expiring' };

  // Claim the day first, so an overlapping run can't send a second one.
  const claim = await db
    .prepare(
      `INSERT INTO meta (key, value) VALUES ('last_reminder_day', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE value IS NOT excluded.value`
    )
    .bind(today)
    .run();
  if (!claim.meta.changes) return { sent: 0, reason: 'already_sent' };

  const { results } = await db.prepare(`SELECT endpoint FROM push_subscriptions`).all();
  const contact = /^https:/.test(prefs.origin || '') ? prefs.origin : FALLBACK_SUB;
  let sent = 0;
  for (const { endpoint } of results) {
    if (await sendPush(db, endpoint, contact, now, fetch)) sent++;
  }
  return { sent, reason: 'sent' };
}

// One payload-less push. A subscription the push service no longer knows
// (404 or 410) is deleted. → true when the service accepted it.
export async function sendPush(db, endpoint, contact, now, fetch = globalThis.fetch) {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...(await vapidHeaders(db, endpoint, contact, now)),
        TTL: String(PUSH_TTL),
        Urgency: 'normal',
        'Content-Length': '0',
      },
    });
    if (res.status === 404 || res.status === 410) {
      await db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).bind(endpoint).run();
    }
    return res.ok;
  } catch (err) {
    console.error('push failed', err);
    return false;
  }
}

// ---------------------------------------------------------------------------

async function readPrefs(db) {
  const { results } = await db
    .prepare(`SELECT key, value FROM meta WHERE key IN ('reminder_enabled', 'reminder_hour', 'tz_offset_minutes', 'last_reminder_day', 'app_origin')`)
    .all();
  const m = Object.fromEntries(results.map((r) => [r.key, r.value]));
  return {
    enabled: m.reminder_enabled === '1',
    hour: Number(m.reminder_hour ?? 8),
    tz: Number(m.tz_offset_minutes ?? 0),
    lastDay: m.last_reminder_day || null,
    origin: m.app_origin || null,
  };
}

function setMeta(db, values) {
  return Object.entries(values).map(([key, value]) =>
    db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).bind(key, value)
  );
}

// Push services are https; plain http is allowed for a local stand-in only.
function isPushEndpoint(value) {
  try {
    const u = new URL(value);
    const local = u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname);
    return value.length < 2048 && (u.protocol === 'https:' || local);
  } catch {
    return false;
  }
}

function str(v) {
  return typeof v === 'string' ? v.slice(0, 512) : null;
}
