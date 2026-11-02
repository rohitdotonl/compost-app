// VAPID for Web Push (Phase 8), with WebCrypto only.
//
// The Worker makes its own ECDSA P-256 key pair the first time it needs one
// and keeps it (as a JWK) in the meta table, so there is no secret to create
// or set. Anyone with database access could send pushes as this app to its
// own subscriptions, which for a single-user app is an acceptable trade.
//
// Pushes carry no payload, so the only crypto is the signed JWT in the
// Authorization header (RFC 8292). No aes128gcm, no library.

const KEY_META = 'vapid_jwk';
const ALG = { name: 'ECDSA', namedCurve: 'P-256' };
const JWT_LIFETIME = 12 * 60 * 60; // seconds; push services refuse more than 24h

const loaded = new WeakMap(); // db → Promise<{ privateKey, publicKey }>

// → { privateKey: CryptoKey, publicKey: string } where publicKey is the
// uncompressed point (0x04 || x || y) in base64url, as browsers want it for
// pushManager.subscribe({ applicationServerKey }).
export function vapidKeys(db) {
  if (!loaded.has(db)) {
    loaded.set(db, loadOrCreate(db).catch((err) => { loaded.delete(db); throw err; }));
  }
  return loaded.get(db);
}

async function loadOrCreate(db) {
  let row = await db.prepare(`SELECT value FROM meta WHERE key = ?`).bind(KEY_META).first();
  if (!row) {
    const pair = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    // Two instances may race here; the first key stored wins for both.
    await db.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)`).bind(KEY_META, JSON.stringify(jwk)).run();
    row = await db.prepare(`SELECT value FROM meta WHERE key = ?`).bind(KEY_META).first();
  }
  const jwk = JSON.parse(row.value);
  const privateKey = await crypto.subtle.importKey('jwk', jwk, ALG, false, ['sign']);
  const point = concat(new Uint8Array([4]), fromBase64url(jwk.x), fromBase64url(jwk.y));
  return { privateKey, publicKey: base64url(point) };
}

// The ES256 JWT for one push service: aud is the endpoint's origin, exp at
// most 12 hours ahead, sub a contact URL (the app's https address, or a mailto).
export async function vapidJwt(privateKey, endpoint, sub, now = Date.now()) {
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = { aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + JWT_LIFETIME, sub };
  const input = `${base64url(utf8(JSON.stringify(header)))}.${base64url(utf8(JSON.stringify(payload)))}`;
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, utf8(input)));
  // WebCrypto already returns JWS's raw r || s (64 bytes); a DER signature
  // from some other runtime would be converted.
  return `${input}.${base64url(signature.length === 64 ? signature : derToRaw(signature))}`;
}

// The headers for one payload-less push.
export async function vapidHeaders(db, endpoint, sub, now) {
  const { privateKey, publicKey } = await vapidKeys(db);
  const jwt = await vapidJwt(privateKey, endpoint, sub, now);
  return { Authorization: `vapid t=${jwt}, k=${publicKey}` };
}

// DER SEQUENCE { INTEGER r, INTEGER s } → 32-byte r || 32-byte s.
export function derToRaw(der) {
  const out = new Uint8Array(64);
  let i = 2;
  for (const offset of [0, 32]) {
    const len = der[i + 1];
    let int = der.subarray(i + 2, i + 2 + len);
    while (int.length > 32 && int[0] === 0) int = int.subarray(1);
    out.set(int, offset + 32 - int.length);
    i += 2 + len;
  }
  return out;
}

export function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(text) {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function utf8(s) {
  return new TextEncoder().encode(s);
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
