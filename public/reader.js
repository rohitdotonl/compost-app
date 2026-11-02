// The reader: one article set for reading, at #read/42.
//
// Content comes from GET /api/items/:id/content. The first open of an article
// extracts it in the browser (extract.js) from the raw page the Worker
// fetches, and stores the result for every device. Rack articles are also
// extracted in the background, one at a time while the tab is visible, and
// kept in the Cache API for reading offline.
//
// Hooks for later phases (all on window):
//   'compost:article'        detail { id, item, root }   an article was rendered;
//                            `root` is the element holding the article HTML
//   'compost:progress'       detail { id, progress, activeSeconds }   on scroll
//   'compost:article-closed' detail { id, progress, activeSeconds }
//   currentArticle()         the same fields for the open article, or null
//   openTakeaway()           shows the Done prompt (finish.js, at the end moment)
// While reading, `.reader.focus` marks focus mode: the bar has faded and
// everything but the text and the page stack fades with it (Phase 5).
// activeSeconds counts reading time: it pauses while the tab is hidden or
// after 60s without input, and goes to the server with each progress save
// as `seconds` with the local `day` (Phase 8 adds it to that day's reading time).
import { S } from './strings.js';
import { api, el, getPasscode } from './api.js';
import * as store from './store.js';
import { imgSrc, timeLeft } from './format.js';
import { highlightBackOut, highlightKey, takeawayChoices } from './highlights.js';
import { localDay } from './daily.js';

const ROUTE = /^#read\/(\d+)$/;
const PREFS_KEY = 'compost.reader';
const PROGRESS_KEY = 'compost.progress';
const STATUS_KEY = 'compost.contents';
const CONTENT_CACHE = 'compost-content';
const SAVE_EVERY = 15000;     // progress POSTs at most this often
const CHROME_IDLE = 3000;     // the bar fades after this long without input
const IDLE_LIMIT = 60000;     // reading time stops counting after this long without input
const BACKGROUND_GAP = 1500;  // pause between background extractions
const PREFETCH_IMAGES = 20;   // images per article fetched ahead for offline

const SIZES = [0.85, 0.92, 1, 1.1, 1.2, 1.32];
const WIDTHS = ['56ch', '66ch', '76ch'];
const DEFAULT_PREFS = { size: 2, width: 1, font: 'serif', theme: null };

let view = null;          // the reader's elements, built once
let current = null;       // the open article
let returnScroll = 0;     // rack scroll position to come back to
let fromApp = false;      // entered from the app, so Esc can go back in history
let chromeTimer = null;
let ticker = null;
let saver = null;
let lastInput = Date.now();
let pendingSeconds = 0;   // active seconds not yet sent with a progress save
const contentStatus = new Map(readJSON(STATUS_KEY, []));

export function isReading() {
  return current != null;
}

export function currentArticle() {
  if (!current) return null;
  const { id, item, root, progress, activeSeconds } = current;
  return { id, item, root, progress, activeSeconds };
}

// Built once by app.js. render() runs on every state change and hash change.
export function createReader() {
  view = buildView();
  document.body.append(view.element);
  applyPrefs();
  store.setReader(openFromApp);
  document.addEventListener('click', interceptRackTitle);
  for (const type of ['mousemove', 'pointerdown', 'touchstart', 'wheel', 'keydown']) {
    window.addEventListener(type, onInput, { passive: true });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveProgress(true);
    else scheduleBackground();
  });
  window.addEventListener('pagehide', () => saveProgress(true));
  store.subscribe(scheduleBackground);
  return { render };
}

function render(state) {
  const m = location.hash.match(ROUTE);
  const id = m ? Number(m[1]) : null;
  if (current && current.id === id) return;
  if (current) close();
  if (id == null || !state.data) return;
  open(id);
}

// store.open(id): the reader, or the original when extraction already failed.
function openFromApp(id) {
  const item = findItem(id);
  if (!item) return false;
  if (contentStatus.get(id) === 'failed') {
    openOriginal(item);
    return true;
  }
  fromApp = true;
  location.hash = `#read/${id}`;
  return true;
}

// A plain click on a Rack or Vault row's title opens the reader; the row's
// Open button and modified clicks still go to the original.
function interceptRackTitle(e) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const link = e.target.closest('li.item[data-id] a.title');
  if (!link) return;
  const id = Number(link.closest('li.item').dataset.id);
  if (!findItem(id)) return;
  e.preventDefault();
  store.open(id);
}

function findItem(id) {
  const data = store.getState().data;
  if (!data) return null;
  return data.rack.find((i) => i.id === id) || data.vault.find((i) => i.id === id) || null;
}

// ---------------------------------------------------------------------------
// Opening and closing
// ---------------------------------------------------------------------------

async function open(id) {
  const item = findItem(id);
  if (!item) {
    store.setStatus(S.readerGone);
    location.replace('#rack');
    return;
  }
  returnScroll = window.scrollY;
  current = { id, item, root: null, progress: 0, activeSeconds: 0, dirty: false, userMoved: false };
  document.body.classList.add('reading');
  document.documentElement.dataset.readerTheme = prefs().theme || '';
  view.element.hidden = false;
  fillHead(item, null);
  view.body.replaceChildren(el('p', { className: 'reader-wait' }, S.readerLoading));
  view.end.replaceChildren();
  view.left.textContent = '';
  window.scrollTo(0, 0);
  wakeChrome();

  let content;
  try {
    content = await loadContent(item);
  } catch {
    content = { offline: true };
  }
  if (!current || current.id !== id) return;
  if (content.failed) {
    leave();
    openOriginal(item);
  } else if (content.offline || content.gone) {
    leave();
    store.setStatus(content.gone ? S.readerGone : S.readerOffline);
  } else {
    await renderArticle(item, content);
  }
}

function close() {
  const { id } = current;
  saveProgress(true);
  window.dispatchEvent(new CustomEvent('compost:article-closed', { detail: articleDetail() }));
  clearInterval(ticker);
  clearInterval(saver);
  current = null;
  fromApp = false;
  view.element.hidden = true;
  closeControls({ animate: false });
  view.left.textContent = '';
  view.body.replaceChildren();
  document.body.classList.remove('reading');
  delete document.documentElement.dataset.readerTheme;
  window.scrollTo(0, returnScroll);
  if (store.rackItem(id)) {
    store.select(id);
    requestAnimationFrame(() => document.querySelector(`li.item[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' }));
  }
}

// Back to the rack: one step back in history when we came from it.
function leave() {
  if (fromApp && history.length > 1) history.back();
  else location.replace('#rack');
}

function openOriginal(item) {
  const win = window.open(item.url, '_blank');
  if (win) {
    try { win.opener = null; } catch {}
    store.setStatus(S.readerFailed);
  } else {
    store.setStatus(S.readerFailedBlocked, { label: S.readerOriginal, run: () => window.open(item.url, '_blank', 'noopener') });
  }
}

// ---------------------------------------------------------------------------
// Content: the server, the browser's extraction, the offline cache
// ---------------------------------------------------------------------------

// → content { html, byline, minutes, progress, last_read_at }, or
//   { failed } / { offline } / { gone }.
async function loadContent(item) {
  let res;
  try {
    res = await api(`/api/items/${item.id}/content`);
  } catch {
    return (await cacheGet(item.id)) || { offline: true };
  }
  const { status, data } = res;
  if (status === 200 && data.status === 'ok') {
    setStatus(item.id, 'ok');
    if (isRack(item.id)) cachePut(item.id, data);
    return data;
  }
  if (status === 200 && data.status === 'failed') {
    setStatus(item.id, 'failed');
    return { failed: true };
  }
  if (status === 200 && data.status === 'none') {
    const extracted = await extractAndStore(item);
    return extracted ? { ...extracted, progress: data.progress, last_read_at: data.last_read_at } : { failed: true };
  }
  return { gone: true };
}

// Fetches the raw page through the Worker, extracts it here and stores the
// result. Resolves to the content, or null when extraction failed (which is
// recorded, so no device tries again). Network errors throw.
async function extractAndStore(item) {
  const raw = await api(`/api/items/${item.id}/raw`);
  let result = null;
  if (raw.status === 200 && raw.data.html) {
    try {
      const { extract } = await import('./extract.js');
      result = await extract(raw.data.html, raw.data.url || item.url);
    } catch (err) {
      console.warn('extract failed', err);
    }
  }
  if (!result) {
    if (raw.status !== 404) await api(`/api/items/${item.id}/content`, { status: 'failed' });
    setStatus(item.id, 'failed');
    return null;
  }
  const { html, text, words, excerpt, byline } = result;
  const saved = await api(`/api/items/${item.id}/content`, { html, text, words, excerpt, byline });
  const minutes = (saved.data && saved.data.minutes) || result.minutes;
  if (minutes && minutes !== item.minutes) store.patchItem(item.id, { minutes });
  const content = { status: 'ok', html, words, excerpt, byline, minutes };
  if (saved.status === 200 && saved.data.status === 'ok') {
    setStatus(item.id, 'ok');
    if (isRack(item.id)) cachePut(item.id, content);
  }
  return content;
}

function setStatus(id, status) {
  if (contentStatus.get(id) === status) return;
  contentStatus.set(id, status);
  writeJSON(STATUS_KEY, [...contentStatus]);
}

function isRack(id) {
  return !!store.rackItem(id);
}

const cacheKey = (id) => `/__compost/content/${id}`;
const hasCaches = () => typeof caches !== 'undefined';

async function cachePut(id, content) {
  if (!hasCaches()) return;
  try {
    const cache = await caches.open(CONTENT_CACHE);
    await cache.put(cacheKey(id), new Response(JSON.stringify(content), { headers: { 'Content-Type': 'application/json' } }));
  } catch {}
}

async function cacheGet(id) {
  if (!hasCaches()) return null;
  try {
    const hit = await (await caches.open(CONTENT_CACHE)).match(cacheKey(id));
    return hit ? await hit.json() : null;
  } catch {
    return null;
  }
}

async function cacheHas(id) {
  if (!hasCaches()) return false;
  try { return !!(await (await caches.open(CONTENT_CACHE)).match(cacheKey(id))); } catch { return false; }
}

// Keeps only the rack's articles. Images are capped by the service worker.
async function cacheEvict(keepIds) {
  if (!hasCaches()) return;
  try {
    const cache = await caches.open(CONTENT_CACHE);
    for (const request of await cache.keys()) {
      const id = Number(new URL(request.url).pathname.split('/').pop());
      if (!keepIds.has(id)) await cache.delete(request);
    }
  } catch {}
}

// Asks for each article image once, so the service worker keeps it.
async function prefetchImages(html) {
  if (!navigator.serviceWorker || !navigator.serviceWorker.controller) return;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const sources = [...doc.querySelectorAll('img[src^="/img?"]')].slice(0, PREFETCH_IMAGES).map((img) => img.getAttribute('src'));
  for (const src of sources) {
    try { await fetch(src); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Background: extract and cache the rack, one article at a time
// ---------------------------------------------------------------------------

let backgroundTimer = null;
let backgroundRunning = false;
let statusesLoadedAt = 0;
const attempted = new Set();

function scheduleBackground() {
  clearTimeout(backgroundTimer);
  backgroundTimer = setTimeout(runBackground, 2000);
}

async function runBackground() {
  if (backgroundRunning || document.visibilityState !== 'visible' || !navigator.onLine) return;
  if (!store.getState().data || !getPasscode()) return;
  backgroundRunning = true;
  try {
    const rack = store.rackItems();
    await cacheEvict(new Set(rack.map((i) => i.id)));
    if (Date.now() - statusesLoadedAt > 60000) {
      const { status, data } = await api('/api/contents');
      if (status === 200) {
        statusesLoadedAt = Date.now();
        for (const row of data.contents) setStatus(row.id, row.status);
      }
    }
    for (const item of rack) {
      if (document.visibilityState !== 'visible') break;
      if (attempted.has(item.id) || (current && current.id === item.id)) continue;
      const known = contentStatus.get(item.id);
      if (known === 'failed') continue;
      if (known === 'ok' && (await cacheHas(item.id))) continue;
      attempted.add(item.id);
      const content = known === 'ok' ? await fetchToCache(item) : await extractAndStore(item);
      if (content && content.html) await prefetchImages(content.html);
      await new Promise((r) => setTimeout(r, BACKGROUND_GAP));
    }
  } catch {
    // Offline or signed out: try again on the next change.
  } finally {
    backgroundRunning = false;
  }
}

async function fetchToCache(item) {
  const { status, data } = await api(`/api/items/${item.id}/content`);
  if (status !== 200 || data.status !== 'ok') return null;
  await cachePut(item.id, data);
  return data;
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

// Small line icons, drawn here so the bar needs no image files.
const SVG_NS = 'http://www.w3.org/2000/svg';
function icon(paths, size = 20) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', 'reader-icon');
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}
const ICON_BACK = ['M15 4.5 7.5 12l7.5 7.5'];
const ICON_ORIGINAL = ['M13.5 4.5h6v6', 'M19.5 4.5 11 13', 'M17.5 13.5v4a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h4'];
const ICON_CLOSE = ['M6.5 6.5l11 11', 'M17.5 6.5l-11 11'];

function buildView() {
  const back = el('a', { href: '#rack', className: 'reader-back', 'aria-label': S.readerBackLabel }, icon(ICON_BACK, 22), el('span', {}, S.readerBack));
  back.addEventListener('click', (e) => { e.preventDefault(); leave(); });
  const barTitle = el('span', { className: 'reader-bar-title', 'aria-hidden': 'true' });
  const aa = el('button', { type: 'button', className: 'reader-aa reader-round', 'aria-label': S.readerSettingsLabel, 'aria-expanded': 'false', 'aria-haspopup': 'dialog' }, S.readerSettings);
  const original = el('a', { className: 'reader-original reader-round', target: '_blank', rel: 'noopener noreferrer', 'aria-label': S.readerOriginal, title: S.readerOriginal }, icon(ICON_ORIGINAL, 19));
  const bar = el('nav', { className: 'reader-bar' }, el('div', { className: 'reader-bar-start' }, back), barTitle, el('div', { className: 'reader-bar-end' }, aa, original));
  const controls = buildControls();
  controls.hidden = true;
  const scrim = el('div', { className: 'reader-scrim', hidden: true });
  scrim.addEventListener('click', () => closeControls());
  aa.addEventListener('click', () => {
    if (controls.hidden || controls.classList.contains('closing')) openControls();
    else closeControls();
    wakeChrome();
  });
  window.addEventListener('resize', () => { if (!controls.hidden) placeControls(); });

  const favicon = el('img', { className: 'reader-favicon', alt: '', width: 16, height: 16 });
  favicon.addEventListener('error', () => (favicon.hidden = true));
  const site = el('span', {});
  const title = el('h1', { className: 'reader-title' });
  const meta = el('p', { className: 'reader-meta' });
  const head = el('header', { className: 'reader-head' }, el('p', { className: 'reader-site' }, favicon, site), title, meta);
  const body = el('div', { className: 'reader-body' });
  const end = el('footer', { className: 'reader-end' });
  const page = el('article', { className: 'reader-page' }, head, body, end);
  const left = el('p', { className: 'reader-left', 'aria-hidden': 'true' });
  const element = el('div', { className: 'reader', hidden: true }, bar, page, left, scrim, controls);
  return { element, bar, barTitle, aa, controls, scrim, original, favicon, site, title, meta, body, end, left };
}

// The settings: a bottom sheet on phones, a popover under Aa elsewhere.
function openControls() {
  clearTimeout(view.closing);
  view.controls.classList.remove('closing');
  view.scrim.classList.remove('closing');
  view.controls.hidden = false;
  view.scrim.hidden = false;
  view.aa.setAttribute('aria-expanded', 'true');
  placeControls();
  view.controls.focus({ preventScroll: true });
}

function closeControls({ animate = true } = {}) {
  if (view.controls.hidden) return;
  view.aa.setAttribute('aria-expanded', 'false');
  const calm = !animate || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hide = () => {
    view.controls.classList.remove('closing');
    view.scrim.classList.remove('closing');
    view.controls.hidden = true;
    view.scrim.hidden = true;
  };
  if (view.controls.contains(document.activeElement)) view.aa.focus({ preventScroll: true });
  if (calm) return hide();
  view.controls.classList.add('closing');
  view.scrim.classList.add('closing');
  clearTimeout(view.closing);
  view.closing = setTimeout(hide, 200);
}

// The popover hangs under the Aa button and never leaves the screen.
function placeControls() {
  const c = view.controls;
  if (matchMedia('(max-width: 599px)').matches) {
    c.style.removeProperty('top');
    c.style.removeProperty('left');
    return;
  }
  const a = view.aa.getBoundingClientRect();
  const width = c.offsetWidth;
  const left = Math.min(window.innerWidth - width - 12, Math.max(12, a.right - width + 8));
  c.style.top = `${Math.round(a.bottom + 10)}px`;
  c.style.left = `${Math.round(left)}px`;
  c.style.setProperty('--arrow-x', `${Math.round(a.left + a.width / 2 - left)}px`);
}

function fillHead(item, content) {
  view.original.href = item.url;
  const favicon = imgSrc(item.favicon_url);
  view.favicon.hidden = !favicon;
  if (favicon) view.favicon.src = favicon;
  else view.favicon.removeAttribute('src');
  view.site.textContent = item.site;
  view.title.textContent = item.title;
  view.barTitle.textContent = item.title;
  const parts = [];
  const byline = content && content.byline;
  if (byline) parts.push(byline);
  const minutes = (content && content.minutes) || item.minutes;
  if (minutes) parts.push(S.minutes(minutes));
  if (item.outcome == null) parts.push(timeLeft(item.expires_at, Date.now()));
  view.meta.textContent = parts.join(' · ');
}

async function renderArticle(item, content) {
  const { sanitize } = await import('./extract.js');
  if (!current || current.id !== item.id) return;
  fillHead(item, content);
  view.body.replaceChildren(sanitize(content.html));
  current.root = view.body;
  for (const img of view.body.querySelectorAll('img')) {
    img.addEventListener('load', restoreScroll);
    img.addEventListener('error', () => {
      (img.closest('figure') || img).hidden = true;
      restoreScroll();
    });
  }
  renderEnd(item);
  current.minutes = content.minutes || item.minutes || 0;

  const resume = resumePoint(item, content);
  current.progress = resume.progress;
  current.restoreTo = resume.progress;
  restoreScroll();
  drawLeft();
  ticker = setInterval(tick, 1000);
  saver = setInterval(() => saveProgress(false), SAVE_EVERY);
  // A save that never reached the server (offline, or lost as the page went
  // away) is sent now.
  if (resume.unsent) {
    current.dirty = true;
    saveProgress(false);
  }
  window.dispatchEvent(new CustomEvent('compost:article', { detail: { id: item.id, item, root: view.body } }));
}

// Done and Toss for rack articles. Done asks for the takeaway in place.
function renderEnd(item) {
  if (item.outcome != null) return view.end.replaceChildren();
  const doneBtn = el('button', { type: 'button', className: 'primary' }, S.done);
  const tossBtn = el('button', { type: 'button', className: 'secondary' }, S.toss);
  doneBtn.addEventListener('click', () => askTakeaway(item));
  tossBtn.addEventListener('click', () => {
    saveProgress(true);
    store.toss(item.id);
    leave();
  });
  view.end.replaceChildren(el('div', { className: 'actions' }, doneBtn, tossBtn));
}

// `slide`: the prompt slides up (the end moment, finish.js). `focus: false`
// leaves the field alone, so a touch screen's keyboard stays down.
function askTakeaway(item, { slide = false, focus = true } = {}) {
  const field = el('input', { type: 'text', maxLength: 500, 'aria-label': S.takeawayPrompt, enterKeyHint: 'done' });
  const keep = el('button', { type: 'submit' }, S.keep);
  const skip = el('button', { type: 'button', className: 'secondary' }, S.skip);
  const form = el(
    'form',
    { className: `takeaway${slide ? ' slide-in' : ''}` },
    el('label', {}, S.takeawayPrompt),
    el('div', { className: 'row' }, field, keep, skip),
    takeawayChoices(item, field, { prefill: true })
  );
  const finish = (takeaway) => {
    saveProgress(true);
    store.done(item.id, takeaway);
    leave();
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); finish(field.value.trim()); });
  skip.addEventListener('click', () => finish(''));
  view.end.replaceChildren(form);
  if (focus) field.focus({ preventScroll: slide });
}

// Phase 5: the end moment asks for the takeaway. False when not a rack article.
export function openTakeaway(options) {
  if (!current || current.item.outcome != null || !current.root) return false;
  askTakeaway(current.item, options);
  return true;
}

// ---------------------------------------------------------------------------
// Progress, reading time and the fading bar
// ---------------------------------------------------------------------------

// The most recent of the server's position and this device's own copy
// (which also covers saves made while offline). → { progress, unsent }
function resumePoint(item, content) {
  const local = readJSON(PROGRESS_KEY, {})[item.id];
  const serverAt = content.last_read_at || 0;
  const server = Number(content.progress ?? item.progress) || 0;
  if (local && local.t > serverAt && Math.abs(local.p - server) > 0.001) return { progress: local.p, unsent: true };
  return { progress: server, unsent: false };
}

function scrollFraction() {
  const max = document.documentElement.scrollHeight - window.innerHeight;
  return max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 1;
}

// Images arriving change the height, so the restore is applied again on each
// until the reader moves.
function restoreScroll() {
  if (!current || current.userMoved || !current.restoreTo || current.restoreTo < 0.01) return;
  const max = document.documentElement.scrollHeight - window.innerHeight;
  window.scrollTo(0, Math.round(current.restoreTo * max));
}

let scrollQueued = false;
function onScroll() {
  if (!current || !current.root || scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    if (!current || !current.root) return;
    const progress = scrollFraction();
    if (Math.abs(progress - current.progress) < 0.0005) return;
    current.progress = progress;
    current.dirty = true;
    drawLeft();
    window.dispatchEvent(new CustomEvent('compost:progress', { detail: articleDetail() }));
  });
}

// Keys that scroll the page; like the wheel, they keep focus mode on.
const SCROLL_KEYS = new Set([' ', 'PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', 'Home', 'End']);

function onInput(e) {
  lastInput = Date.now();
  if (!current) return;
  // Scrolling (wheel, touch, scroll keys) keeps focus mode; a mouse move, a
  // tap (which also sends mouse events) or another key brings the bar back.
  const scrolling = e.type === 'wheel' || e.type === 'touchstart' || (e.type === 'pointerdown' && e.pointerType !== 'mouse') ||
    (e.type === 'keydown' && SCROLL_KEYS.has(e.key));
  if (!scrolling) wakeChrome();
  if (e.type === 'wheel'|| e.type === 'touchstart' || e.type === 'keydown' || e.type === 'pointerdown') current.userMoved = true;
}

// One second of reading, if the tab is visible and someone is there.
function tick() {
  if (!current || document.visibilityState !== 'visible' || Date.now() - lastInput > IDLE_LIMIT) return;
  current.activeSeconds++;
  pendingSeconds++;
}

// Sends the position (and the reading seconds since the last save). With
// keepalive it survives the tab closing.
function saveProgress(keepalive) {
  if (!current || !current.root) return;
  if (!current.dirty && !pendingSeconds) return;
  const { id, item } = current;
  const progress = Math.round(current.progress * 10000) / 10000;
  const seconds = pendingSeconds;
  pendingSeconds = 0;
  current.dirty = false;
  const at = Date.now();
  item.progress = progress;
  item.last_read_at = at;
  const local = readJSON(PROGRESS_KEY, {});
  local[id] = { p: progress, t: at };
  writeJSON(PROGRESS_KEY, Object.fromEntries(Object.entries(local).sort((x, y) => y[1].t - x[1].t).slice(0, 50)));
  fetch(`/api/items/${id}/progress`, {
    method: 'POST',
    keepalive,
    headers: { 'Content-Type': 'application/json', 'X-Passcode': getPasscode() },
    body: JSON.stringify({ progress, seconds, day: localDay() }),
  })
    .then((res) => { if (!res.ok && res.status !== 404) pendingSeconds += seconds; })
    .catch(() => { pendingSeconds += seconds; });
}

// "12 min left", or "Last page" near the end. Nothing when the length is unknown.
function drawLeft() {
  if (!current || !current.root) return;
  const minutes = current.minutes;
  if (!minutes) {
    view.left.textContent = '';
    return;
  }
  const left = Math.ceil(minutes * (1 - current.progress));
  view.left.textContent = current.progress >= 0.97 || left < 1 ? S.readerLastPage : S.readerMinutesLeft(left);
}

function articleDetail() {
  const { id, progress, activeSeconds } = current;
  return { id, progress, activeSeconds };
}

function wakeChrome() {
  if (!view) return;
  view.bar.classList.remove('faded');
  view.element.classList.remove('focus');
  clearTimeout(chromeTimer);
  chromeTimer = setTimeout(() => {
    if (!current || !view.controls.hidden || view.bar.contains(document.activeElement)) return;
    view.bar.classList.add('faded');
    view.element.classList.add('focus');
  }, CHROME_IDLE);
}

// The reader's rung on keys.js's Esc ladder: settings, then the takeaway
// prompt, then back to the rack. True when it did something.
export function readerBackOut() {
  if (!current) return false;
  if (highlightBackOut()) return true; // Phase 5: a highlight's popover
  if (!view.controls.hidden && !view.controls.classList.contains('closing')) {
    closeControls();
  } else if (view.end.querySelector('form')) {
    renderEnd(current.item);
  } else {
    leave();
  }
  return true;
}

// keys.js hands every other key here while reading (the rack's shortcuts
// are off). Shift+O opens the original; h, n and s belong to the highlights
// (Phase 5); Enter accepts an open takeaway prompt. True when it took the key.
export function readerKey(key) {
  if (!current) return false;
  if (key === 'O') {
    window.open(current.item.url, '_blank', 'noopener');
    return true;
  }
  if (highlightKey(key)) return true;
  const form = view.end.querySelector('form.takeaway');
  const onControl = document.activeElement && document.activeElement.closest && document.activeElement.closest('button, a');
  if (key === 'Enter' && form && !onControl) {
    form.requestSubmit();
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Reading settings (this device only)
// ---------------------------------------------------------------------------

function prefs() {
  return { ...DEFAULT_PREFS, ...readJSON(PREFS_KEY, {}) };
}

function setPref(key, value) {
  writeJSON(PREFS_KEY, { ...prefs(), [key]: value });
  applyPrefs();
}

function applyPrefs() {
  const p = prefs();
  const r = view.element;
  r.style.setProperty('--r-scale', SIZES[p.size] ?? 1);
  r.style.setProperty('--r-measure', WIDTHS[p.width] ?? WIDTHS[1]);
  r.dataset.font = p.font;
  if (current) document.documentElement.dataset.readerTheme = p.theme || '';
  for (const button of view.controls.querySelectorAll('[aria-pressed]')) {
    const value = button.dataset.pref === 'theme' ? p.theme || 'auto' : p[button.dataset.pref];
    button.setAttribute('aria-pressed', String(value === button.dataset.value));
  }
  view.controls.querySelector('[data-step="size-"]').disabled = p.size <= 0;
  view.controls.querySelector('[data-step="size+"]').disabled = p.size >= SIZES.length - 1;
  view.controls.querySelector('[data-step="width-"]').disabled = p.width <= 0;
  view.controls.querySelector('[data-step="width+"]').disabled = p.width >= WIDTHS.length - 1;
}

function buildControls() {
  const step = (key, delta, content, label) => {
    const button = el('button', { type: 'button', className: `reader-step reader-step-${key}`, dataset: { step: `${key}${delta > 0 ? '+' : '-'}` }, 'aria-label': label }, ...content);
    button.addEventListener('click', () => {
      const max = (key === 'size' ? SIZES : WIDTHS).length - 1;
      setPref(key, Math.min(max, Math.max(0, prefs()[key] + delta)));
    });
    return button;
  };
  const choice = (key, value, className, ...content) => {
    const button = el('button', { type: 'button', className, dataset: { pref: key, value }, 'aria-pressed': 'false' }, ...content);
    button.addEventListener('click', () => setPref(key, key === 'theme' && value === 'auto' ? null : value));
    return button;
  };
  const section = (label, className, ...buttons) => {
    const id = `reader-set-${className}`;
    return el('div', { className: `reader-set reader-set-${className}`, role: 'group', 'aria-labelledby': id },
      el('p', { className: 'reader-set-label', id }, label), el('div', { className: 'reader-set-row' }, ...buttons));
  };
  const close = el('button', { type: 'button', className: 'reader-sheet-close', 'aria-label': S.readerSheetClose }, icon(ICON_CLOSE, 16));
  close.addEventListener('click', () => closeControls());
  const swatch = () => el('span', { className: 'reader-swatch', 'aria-hidden': 'true' }, el('span', { className: 'reader-swatch-text' }, S.readerThemeSwatch));
  const widthIcon = (narrow) => el('span', { className: `reader-width-icon${narrow ? ' narrow' : ''}`, 'aria-hidden': 'true' }, el('i'), el('i'), el('i'));
  const sheet = el(
    'div',
    { className: 'reader-controls', role: 'dialog', 'aria-label': S.readerSettingsLabel, tabIndex: -1 },
    el('div', { className: 'reader-grabber', 'aria-hidden': 'true' }),
    el('div', { className: 'reader-sheet-head' }, el('h2', {}, S.readerSheetTitle), close),
    section(S.readerSize, 'size',
      step('size', -1, [el('span', { className: 'reader-a small', 'aria-hidden': 'true' }, 'A')], S.readerSmallerLabel),
      step('size', 1, [el('span', { className: 'reader-a large', 'aria-hidden': 'true' }, 'A')], S.readerLargerLabel)),
    section(S.readerWidth, 'width',
      step('width', -1, [widthIcon(true), el('span', {}, S.readerNarrower)], S.readerNarrower),
      step('width', 1, [widthIcon(false), el('span', {}, S.readerWider)], S.readerWider)),
    section(S.readerFont, 'font',
      choice('font', 'serif', 'reader-card reader-font-serif', el('span', { className: 'reader-card-aa', 'aria-hidden': 'true' }, 'Aa'), el('span', {}, S.readerFonts.serif)),
      choice('font', 'sans', 'reader-card reader-font-sans', el('span', { className: 'reader-card-aa', 'aria-hidden': 'true' }, 'Aa'), el('span', {}, S.readerFonts.sans))),
    section(S.readerTheme, 'theme',
      ...['auto', 'light', 'sepia', 'quiet', 'dark'].map((t) => choice('theme', t, `reader-theme-card theme-${t}`, swatch(), el('span', { className: 'reader-theme-name' }, S.readerThemes[t]))))
  );
  // Tab stays inside the open sheet.
  sheet.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const items = [...sheet.querySelectorAll('button:not(:disabled)')];
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === sheet)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  return sheet;
}

function readJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}
