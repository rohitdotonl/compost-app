// URLs and page info: normalising a link, and fetching a page for its title,
// description, image, favicon, author, language and a reading-time estimate.
import { FETCH_TIMEOUT, TRACKING_PARAMS, WORDS_PER_MINUTE } from './rules.js';

const PAGE_MAX_BYTES = 3_000_000;

// One fetch for the page details and the reader's raw HTML alike.
function getPage(url) {
  return fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Compost/1.0; personal read-later)',
      Accept: 'text/html,application/xhtml+xml',
    },
  });
}

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

// Fetches the page once for its details and a reading-time estimate.
// Any failure just means no details: the row falls back to the URL.
export async function fetchPageInfo(url) {
  try {
    const res = await getPage(url);
    if (!res.ok || !/html/i.test(res.headers.get('content-type') || '')) return emptyPage();
    // Relative image and icon links resolve against where the page ended up.
    return parsePage(await readCapped(res, PAGE_MAX_BYTES), res.url || url);
  } catch {
    return emptyPage();
  }
}

export function emptyPage() {
  return { title: null, minutes: null, description: null, image: null, favicon: null, author: null, lang: null };
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

// Pure: HTML in, details out. `pageUrl` is only used to make image and icon
// links absolute; without it they are left out.
export function parsePage(html, pageUrl = null) {
  const head = (html.match(/^[\s\S]*?<\/head>/i) || [html.slice(0, 200_000)])[0];
  const metas = tagAttributes(head, 'meta');
  const links = tagAttributes(head, 'link');
  const meta = (...keys) => {
    for (const key of keys) {
      const hit = metas.find((m) => (m.property || m.name || '').toLowerCase() === key && m.content && m.content.trim());
      if (hit) return text(hit.content);
    }
    return null;
  };

  const tag = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = (meta('og:title') || text((tag && tag[1]) || '')).slice(0, 300) || null;
  const description = (meta('og:description', 'twitter:description', 'description') || '').slice(0, 300) || null;
  const image = absolute(meta('og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src'), pageUrl);
  const author = nameOnly(meta('author', 'article:author'));
  const langMatch = html.match(/<html\b[^>]*\blang=["']?([a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{1,8})*)/i);

  return { title, minutes: readingMinutes(html), description, image, favicon: favicon(links, pageUrl), author, lang: langMatch ? langMatch[1] : null };
}

// Every <tag ...> as an object of its attributes, names lowercased.
function tagAttributes(html, name) {
  const out = [];
  for (const [, attrs] of html.matchAll(new RegExp(`<${name}\\b([^>]*)>`, 'gi'))) {
    const obj = {};
    for (const [, key, , v1, v2, v3] of attrs.matchAll(/([\w:-]+)\s*(=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
      obj[key.toLowerCase()] = v1 ?? v2 ?? v3 ?? '';
    }
    out.push(obj);
  }
  return out;
}

// rel="icon" (or "shortcut icon"), then the apple-touch-icon, then /favicon.ico.
function favicon(links, pageUrl) {
  const rels = (l) => (l.rel || '').toLowerCase().split(/\s+/);
  const link = links.find((l) => l.href && rels(l).includes('icon')) || links.find((l) => l.href && rels(l).some((r) => r.startsWith('apple-touch-icon')));
  return absolute(link ? decodeEntities(link.href) : '/favicon.ico', pageUrl);
}

function absolute(href, pageUrl) {
  if (!href || !pageUrl) return null;
  try {
    const url = new URL(href.trim(), pageUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString().slice(0, 2000) : null;
  } catch {
    return null;
  }
}

// article:author is often a profile URL; only a name is worth showing.
function nameOnly(value) {
  if (!value || /^(https?:)?\/\/|^www\.|\.(com|org|net)\b/i.test(value)) return null;
  return value.replace(/^@/, '').slice(0, 100) || null;
}

function readingMinutes(html) {
  const body = (html.match(/<body[\s\S]*<\/body>/i) || [html])[0];
  const words = decodeEntities(
    body
      .replace(/<(script|style|noscript|svg|template|nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return words >= 150 ? Math.max(1, Math.round(words / WORDS_PER_MINUTE)) : null;
}

function text(s) {
  return cleanText(decodeEntities(s));
}

export function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', middot: '·' };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    return named[e.toLowerCase()] ?? m;
  });
}

export function cleanText(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

// Phase 4: the raw HTML for extraction in the browser, fetched the same way
// as fetchPageInfo but not parsed here.
// Resolves to { ok: true, url, html } with the URL after redirects, or
// { ok: false, reason }.
export async function fetchRawPage(url) {
  try {
    const res = await getPage(url);
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    if (!/html/i.test(res.headers.get('content-type') || '')) return { ok: false, reason: 'not_html' };
    return { ok: true, url: res.url || url, html: await readCapped(res, PAGE_MAX_BYTES) };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}
