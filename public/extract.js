// Turns a raw page into clean article HTML, in the browser: DOMParser, then
// Mozilla's Readability, then DOMPurify, then a pass that resolves links,
// routes images through the /img proxy and sets proper quotes and dashes.
// The Worker only fetches the raw HTML (see src/reader.js).
//
// The small helpers at the top are pure, so the tests run them under Node.
import DOMPurify from './vendor/purify.es.mjs';
import { imgSrc } from './format.js';

export const WORDS_PER_MINUTE = 230; // the same as src/rules.js
export const MIN_WORDS = 120;        // less than this is a paywall or a stub, not an article

export function countWords(text) {
  return String(text || '').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

export function minutesFor(words) {
  return words > 0 ? Math.max(1, Math.round(words / WORDS_PER_MINUTE)) : null;
}

// An absolute http(s) URL, or null.
export function absoluteUrl(href, base) {
  if (!href) return null;
  try {
    const url = new URL(String(href).trim(), base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

// Article images load through the Worker's image proxy, so the reader works
// offline (the service worker caches /img) and pages can't track the read.
export function proxiedImage(src, base) {
  if (!src) return null;
  if (/^data:image\//i.test(src)) return src;
  if (src.startsWith('/img?')) return src;
  return imgSrc(absoluteUrl(src, base));
}

// The widest candidate up to about 1600px from a srcset, else the first.
export function pickSrcset(srcset) {
  const candidates = String(srcset || '')
    .split(/,\s+(?=\S)/)
    .map((part) => {
      const [url, size = ''] = part.trim().split(/\s+/);
      const width = /w$/.test(size) ? parseInt(size, 10) : /x$/.test(size) ? parseFloat(size) * 800 : 0;
      return { url, width };
    })
    .filter((c) => c.url);
  if (!candidates.length) return null;
  const fitting = candidates.filter((c) => c.width <= 1600).sort((a, b) => b.width - a.width);
  return (fitting[0] || candidates[0]).url;
}

// Straight quotes and dashes become typographic ones. `before` is the
// character just before this text (it decides whether a quote opens).
export function smarten(text, before = ' ') {
  let out = '';
  let prev = before;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const opening = /[\s([{—–-]/.test(prev) || prev === '';
    let r = c;
    if (c === '"') r = opening ? '“' : '”';
    else if (c === "'") r = opening ? '‘' : '’';
    else if (c === '-' && text[i + 1] === '-') { r = '—'; i++; if (text[i + 1] === '-') i++; }
    else if (c === '.' && text.startsWith('...', i)) { r = '…'; i += 2; }
    out += r;
    prev = r;
  }
  return out;
}

// What the stored article may contain. Everything else (scripts, iframes,
// forms, styles, event handlers, classes) is dropped.
export const PURIFY = {
  ALLOWED_TAGS: [
    'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'img', 'figure', 'figcaption',
    'pre', 'code', 'kbd', 'samp', 'var', 'blockquote', 'q', 'cite', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
    'em', 'strong', 'b', 'i', 'u', 's', 'del', 'ins', 'sub', 'sup', 'small', 'mark', 'abbr', 'time',
    'span', 'div', 'section', 'article', 'details', 'summary',
  ],
  ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'width', 'height', 'colspan', 'rowspan', 'scope', 'datetime', 'cite', 'start', 'reversed', 'lang', 'dir'],
  ALLOW_DATA_ATTR: false,
};

// Sanitises again at render time (the stored HTML came from a browser).
export function sanitize(html) {
  const fragment = DOMPurify.sanitize(html, { ...PURIFY, RETURN_DOM_FRAGMENT: true });
  for (const a of fragment.querySelectorAll('a[href]')) {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
  return fragment;
}

// raw page → { html, text, words, minutes, excerpt, byline, title }, or
// null when there is no article worth reading in it.
export async function extract(rawHtml, pageUrl) {
  const Readability = await loadReadability();
  const doc = new DOMParser().parseFromString(rawHtml, 'text/html');
  const base = doc.createElement('base');
  base.href = pageUrl;
  doc.head.prepend(base);
  fixImages(doc, pageUrl);

  const article = new Readability(doc, { keepClasses: false }).parse();
  if (!article || !article.content) return null;

  const fragment = DOMPurify.sanitize(article.content, { ...PURIFY, RETURN_DOM_FRAGMENT: true });
  tidy(fragment, pageUrl);
  dropBylineLine(fragment, article.byline);
  const box = document.createElement('div');
  box.append(fragment);

  const text = box.textContent.replace(/\s+/g, ' ').trim();
  const words = countWords(text);
  if (words < MIN_WORDS) return null;
  return {
    html: box.innerHTML,
    text,
    words,
    minutes: minutesFor(words),
    excerpt: (article.excerpt || '').trim().slice(0, 500),
    byline: (article.byline || '').trim().slice(0, 200),
    title: (article.title || '').trim(),
  };
}

// Lazy-loaded images keep the real address in srcset or a data attribute.
function fixImages(doc, base) {
  for (const img of doc.querySelectorAll('img')) {
    const lazy = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original');
    const set = img.getAttribute('srcset') || img.getAttribute('data-srcset') ||
      img.closest('picture')?.querySelector('source[srcset]')?.getAttribute('srcset');
    const src = img.getAttribute('src');
    const best = lazy || (set && pickSrcset(set)) || src;
    if (best) img.setAttribute('src', absoluteUrl(best, base) || best);
    img.removeAttribute('srcset');
  }
}

// After sanitising: images through the proxy, absolute links, typography.
function tidy(root, base) {
  for (const img of root.querySelectorAll('img')) {
    const src = proxiedImage(img.getAttribute('src'), base);
    if (!src) { (img.closest('figure') || img).remove(); continue; }
    img.setAttribute('src', src);
    img.setAttribute('loading', 'lazy');
    img.setAttribute('decoding', 'async');
  }
  for (const a of root.querySelectorAll('a')) {
    const href = absoluteUrl(a.getAttribute('href'), base);
    if (href) a.setAttribute('href', href);
    else a.removeAttribute('href');
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let before = ' ';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest('pre, code, kbd, samp')) continue;
    const value = node.nodeValue;
    if (!value) continue;
    node.nodeValue = smarten(value, before);
    before = value[value.length - 1];
  }
}

// The reader shows the byline in its header, so a short "By …" line near
// the top of the article is a duplicate.
function dropBylineLine(root, byline) {
  if (!byline) return;
  const needle = byline.trim().toLowerCase();
  for (const node of [...root.querySelectorAll('p, div')].slice(0, 4)) {
    const text = node.textContent.trim();
    if (text.length < 160 && text.toLowerCase().includes(needle)) return node.remove();
  }
}

// Readability ships as a classic script that defines a global; load it once.
let readability = null;
function loadReadability() {
  if (window.Readability) return Promise.resolve(window.Readability);
  readability ||= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/Readability.js';
    script.onload = () => resolve(window.Readability);
    script.onerror = () => { readability = null; reject(new Error('readability_unavailable')); };
    document.head.append(script);
  });
  return readability;
}
