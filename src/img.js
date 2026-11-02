// The image proxy: GET /img?u=<encoded url>. Rows show preview images and
// favicons through it, so pages never see your reading (no hotlinking) and
// a picture is fetched once a week rather than on every open.
//
// An <img> can't send the X-Passcode header, so the proxy checks a cookie
// instead: every authenticated API answer sets `compost_img` to the SHA-256
// of the passcode, scoped to /img. Without it, or on any failure, the answer
// is a plain 404 and the row shows its tinted tile.
import { safeEqual } from './http.js';
import { DAY } from './rules.js';

export const IMG_COOKIE = 'compost_img';
const IMG_MAX_BYTES = 2_000_000;
const IMG_TIMEOUT = 5000;
const IMG_KEEP = 7 * DAY;
const FAILURE_KEEP = 60 * 60 * 1000; // the browser skips a broken image this long

export async function handleImg(request, env, { fetchImpl = fetch, cache = defaultCache() } = {}) {
  if (request.method !== 'GET' || !env.PASSCODE) return notFound();
  const cookie = readCookie(request.headers.get('Cookie'), IMG_COOKIE);
  if (!cookie || !safeEqual(cookie, await imgToken(env.PASSCODE))) return notFound();

  const target = imageUrl(new URL(request.url).searchParams.get('u'));
  if (!target) return notFound();

  // Keyed on the address alone, so the cookie never splits the cache.
  const key = new Request(`https://img.compost.internal/?u=${encodeURIComponent(target)}`);
  const hit = cache && (await cache.match(key));
  if (hit) return forBrowser(hit);

  const upstream = await fetchImage(target, fetchImpl);
  if (!upstream) return notFound(FAILURE_KEEP);
  const stored = new Response(upstream.body, {
    headers: { 'Content-Type': upstream.type, 'Cache-Control': `public, max-age=${IMG_KEEP / 1000}` },
  });
  if (cache) await cache.put(key, stored.clone());
  return forBrowser(stored);
}

// The cookie value: hex SHA-256 of the passcode.
export async function imgToken(passcode) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(passcode));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Adds the cookie to an authenticated API answer, unless the browser
// already sent the right one.
export async function withImgCookie(response, request, passcode) {
  const token = await imgToken(passcode);
  if (readCookie(request.headers.get('Cookie'), IMG_COOKIE) === token) return response;
  const res = new Response(response.body, response);
  res.headers.append(
    'Set-Cookie',
    `${IMG_COOKIE}=${token}; Path=/img; Max-Age=${400 * 24 * 60 * 60}; Secure; HttpOnly; SameSite=Strict`
  );
  return res;
}

function imageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

// { body, type } for an image under the size cap, or null.
async function fetchImage(url, fetchImpl) {
  try {
    const res = await fetchImpl(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(IMG_TIMEOUT),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Compost/1.0; personal read-later)', Accept: 'image/*' },
    });
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!res.ok || !type.startsWith('image/')) return null;
    if (Number(res.headers.get('content-length') || 0) > IMG_MAX_BYTES) return null;
    const body = await readAll(res, IMG_MAX_BYTES);
    return body ? { body, type } : null;
  } catch {
    return null;
  }
}

// The whole body, or null if it runs past maxBytes.
async function readAll(res, maxBytes) {
  const reader = res.body.getReader();
  const chunks = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(bytes);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
  return out;
}

// Private to this browser, and an SVG opened on its own can't run script.
function forBrowser(res) {
  return new Response(res.body, {
    headers: {
      'Content-Type': res.headers.get('Content-Type'),
      'Cache-Control': `private, max-age=${IMG_KEEP / 1000}`,
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

// A missing cookie is never cached (it may arrive a moment later); an image
// that couldn't be fetched is, briefly, so rows don't keep asking for it.
function notFound(keepMs = 0) {
  const cache = keepMs ? `private, max-age=${keepMs / 1000}` : 'no-store';
  return new Response('Not found', { status: 404, headers: { 'Cache-Control': cache } });
}

function readCookie(header, name) {
  for (const part of (header || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

function defaultCache() {
  return typeof caches !== 'undefined' && caches.default ? caches.default : null;
}
