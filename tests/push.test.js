import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, T0 } from './helpers.js';
import worker from '../src/worker.js';
import { digest, runScheduled } from '../src/push.js';
import { derToRaw, fromBase64url, vapidKeys } from '../src/vapid.js';

const HOUR = 36e5;
const DAY = 864e5;
const ENDPOINT = 'https://push.example.net/send/abc';
const ENDPOINT_2 = 'https://fcm.example.com/send/def';
// T0 is Monday 09:00 UTC; saves at T0 expire next Monday 09:00 UTC.
const SUNDAY_MIDNIGHT = T0 + 6 * DAY - 9 * HOUR; // Sunday 00:00 UTC

function subscription(endpoint = ENDPOINT) {
  return { endpoint, keys: { p256dh: 'BPk', auth: 'au' } };
}

function turnOn(app, { hour = 8, tzOffset = 120, endpoint = ENDPOINT, now = T0 } = {}) {
  return app.call('POST', '/api/push/subscribe', { subscription: subscription(endpoint), hour, tzOffset }, { now });
}

// A fetch that records every push and answers with `status(endpoint)`.
function fakePush(status = () => 201) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, headers: init.headers, method: init.method });
    return new Response(null, { status: status(url) });
  };
  return { calls, fetch };
}

async function fillRack(app, n) {
  for (let i = 0; i < n; i++) await app.save(`https://example.com/p${i}`);
}

test('the VAPID key is made once, kept in meta, and survives a new Worker instance', async () => {
  const app = makeApp();
  const first = await app.call('GET', '/api/push/key');
  assert.equal(first.status, 200);
  const raw = fromBase64url(first.data.key);
  assert.equal(raw.length, 65);
  assert.equal(raw[0], 4);

  const row = await app.db.prepare(`SELECT value FROM meta WHERE key = 'vapid_jwk'`).first();
  const jwk = JSON.parse(row.value);
  assert.equal(jwk.crv, 'P-256');
  assert.ok(jwk.d, 'the private part is stored');

  // A fresh wrapper over the same database is like a new Worker instance.
  const again = new app.db.constructor(app.db.sqlite);
  assert.equal((await vapidKeys(again)).publicKey, first.data.key);
  assert.equal((await app.call('GET', '/api/push/key')).data.key, first.data.key);
});

test('a push carries a VAPID JWT that verifies with the public key, and no payload', async () => {
  const app = makeApp();
  await fillRack(app, 1);
  await turnOn(app, { hour: 8, tzOffset: 0 });
  const push = fakePush();
  const now = T0 + 7 * DAY - HOUR; // the next Monday, 08:00 UTC = 8:00 local
  const result = await runScheduled(app.env, { now, fetch: push.fetch });
  assert.deepEqual(result, { sent: 1, reason: 'sent' });

  const [call] = push.calls;
  assert.equal(call.url, ENDPOINT);
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.TTL, '43200');
  assert.equal(call.headers.Urgency, 'normal');
  assert.equal(call.headers['Content-Length'], '0');

  const m = call.headers.Authorization.match(/^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/);
  assert.ok(m, call.headers.Authorization);
  const [jwt, k] = [m[1], m[2]];
  assert.equal(k, (await app.call('GET', '/api/push/key')).data.key);

  const [h, p, s] = jwt.split('.');
  const header = JSON.parse(new TextDecoder().decode(fromBase64url(h)));
  const payload = JSON.parse(new TextDecoder().decode(fromBase64url(p)));
  assert.deepEqual(header, { typ: 'JWT', alg: 'ES256' });
  assert.equal(payload.aud, 'https://push.example.net');
  assert.ok(payload.exp > now / 1000 && payload.exp <= now / 1000 + 12 * 3600);
  // The test origin is http, so the contact falls back to a mailto.
  assert.match(payload.sub, /^mailto:/);

  const signature = fromBase64url(s);
  assert.equal(signature.length, 64, 'raw r || s, not DER');
  const key = await crypto.subtle.importKey('raw', fromBase64url(k), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, new TextEncoder().encode(`${h}.${p}`));
  assert.ok(ok, 'signature verifies');
});

test('derToRaw turns a DER ECDSA signature into 64 raw bytes', () => {
  const r = new Uint8Array(32).fill(0x81); // high bit set: DER pads with a zero
  const s = new Uint8Array(31).fill(0x22); // short: raw pads on the left
  const der = new Uint8Array([0x30, 2 + 33 + 2 + 31, 0x02, 33, 0, ...r, 0x02, 31, ...s]);
  const raw = derToRaw(der);
  assert.equal(raw.length, 64);
  assert.deepEqual([...raw.subarray(0, 32)], [...r]);
  assert.equal(raw[32], 0);
  assert.deepEqual([...raw.subarray(33)], [...s]);
});

test('the digest counts rack items leaving within 24 hours, in words', async () => {
  const app = makeApp();
  assert.deepEqual((await app.call('GET', '/api/digest')).data, { text: null, count: 0 });

  await fillRack(app, 2);
  await app.save('https://example.com/later', { now: T0 + 2 * DAY }); // leaves two days later
  const sundayEvening = T0 + 6 * DAY + 10 * HOUR; // Sunday 19:00 UTC
  assert.deepEqual((await app.call('GET', '/api/digest', undefined, { now: sundayEvening })).data, {
    text: 'Two articles leave your rack tomorrow.',
    count: 2,
  });
  const mondayMorning = T0 + 7 * DAY - 6 * HOUR; // Monday 03:00 UTC, they leave at 09:00
  assert.equal((await digest(app.db, mondayMorning, 0)).text, 'Two articles leave your rack today.');

  await app.call('POST', '/api/items/1/toss', undefined, { now: sundayEvening });
  assert.equal((await digest(app.db, sundayEvening, 0)).text, 'One article leaves your rack tomorrow.');
});

test('the scheduled run sends at the chosen local hour, once a day, and only when something expires', async () => {
  const app = makeApp();
  await fillRack(app, 2);
  await turnOn(app, { hour: 8, tzOffset: 120 }); // 8:00 at UTC+2 is 06:00 UTC
  await turnOn(app, { hour: 8, tzOffset: 120, endpoint: ENDPOINT_2 });
  const push = fakePush();

  const sent = [];
  for (let h = 0; h < 24; h++) {
    const now = SUNDAY_MIDNIGHT + h * HOUR;
    const r = await runScheduled(app.env, { now, fetch: push.fetch });
    if (r.sent) sent.push(new Date(now).toISOString());
  }
  // Sunday 06:00 UTC: the items leave Monday 09:00 UTC, more than 24h away.
  assert.deepEqual(sent, []);

  for (let h = 24; h < 48; h++) {
    const now = SUNDAY_MIDNIGHT + h * HOUR;
    const r = await runScheduled(app.env, { now, fetch: push.fetch });
    if (r.sent) sent.push(new Date(now).toISOString());
  }
  assert.deepEqual(sent, ['2026-10-12T06:00:00.000Z']);
  assert.equal(push.calls.length, 2, 'one push to each browser');

  // A second run in the same hour sends nothing more.
  const again = await runScheduled(app.env, { now: SUNDAY_MIDNIGHT + 30 * HOUR + 60e3, fetch: push.fetch });
  assert.equal(again.reason, 'already_sent');
  assert.equal(push.calls.length, 2);
  const last = await app.db.prepare(`SELECT value FROM meta WHERE key = 'last_reminder_day'`).first();
  assert.equal(last.value, '2026-10-12');
});

test('nothing is sent while the reminder is off or nothing is expiring', async () => {
  const app = makeApp();
  await fillRack(app, 1);
  const push = fakePush();
  const leavingSoon = T0 + 7 * DAY - 3 * HOUR; // Monday 06:00 UTC
  assert.equal((await runScheduled(app.env, { now: leavingSoon, fetch: push.fetch })).reason, 'off');

  const empty = makeApp();
  await turnOn(empty, { hour: 6, tzOffset: 0 });
  assert.equal((await runScheduled(empty.env, { now: leavingSoon, fetch: push.fetch })).reason, 'nothing_expiring');
  assert.equal(push.calls.length, 0);
});

test('a subscription the push service answers 404 or 410 for is deleted', async () => {
  const app = makeApp();
  await fillRack(app, 1);
  await turnOn(app, { hour: 6, tzOffset: 0 });
  await turnOn(app, { hour: 6, tzOffset: 0, endpoint: ENDPOINT_2 });
  const push = fakePush((url) => (url === ENDPOINT ? 410 : 201));
  const r = await runScheduled(app.env, { now: T0 + 7 * DAY - 3 * HOUR, fetch: push.fetch });
  assert.equal(r.sent, 1);
  const { results } = await app.db.prepare(`SELECT endpoint FROM push_subscriptions`).all();
  assert.deepEqual(results.map((x) => x.endpoint), [ENDPOINT_2]);
});

test('subscribe, status and unsubscribe; the reminder turns off with the last browser', async () => {
  const app = makeApp();
  const off = await app.call('GET', `/api/push/status?endpoint=${encodeURIComponent(ENDPOINT)}`);
  assert.deepEqual(off.data, { enabled: false, hour: 8, tzOffset: 0, subscribed: false });

  assert.equal((await turnOn(app, { hour: 24 })).status, 400);
  assert.equal((await app.call('POST', '/api/push/subscribe', { subscription: { endpoint: 'ftp://x' }, hour: 8, tzOffset: 0 })).status, 400);

  const on = await turnOn(app, { hour: 21, tzOffset: -300 });
  assert.deepEqual(on.data, { enabled: true, hour: 21, tzOffset: -300, subscribed: true });

  const gone = await app.call('POST', '/api/push/unsubscribe', { endpoint: ENDPOINT });
  assert.deepEqual(gone.data, { enabled: false, hour: 21, tzOffset: -300, subscribed: false });
});

test('the Worker exports a scheduled handler that runs inside waitUntil', async () => {
  const app = makeApp();
  const pending = [];
  worker.scheduled({ scheduledTime: T0, cron: '0 * * * *' }, app.env, { waitUntil: (p) => pending.push(p) });
  assert.equal(pending.length, 1);
  assert.deepEqual(await pending[0], { sent: 0, reason: 'off' });
});
