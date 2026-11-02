// Highlights in the reader (Phase 5): select text, then the small Highlight
// button or h. Click a highlight for its note (n), the takeaway star (s) or
// Remove. Wide screens list them quietly in the right margin.
//
// Each highlight is stored as a W3C text quote: the exact words plus ~32
// characters either side. On every render it is found again by searching
// the article's text, ignoring whitespace (so a cleaned-up copy of the HTML
// still matches), with the prefix and suffix choosing between repeats. The
// pure helpers (buildIndex, describe, findQuote) run under Node in the tests.
import { S } from './strings.js';
import { api, el } from './api.js';
import * as store from './store.js';

const CONTEXT = 32;
const MARGIN_MIN = 220;   // room needed right of the column for the margin list
const STATUS_MS = 4000;

// ---------------------------------------------------------------------------
// Pure text-quote helpers
// ---------------------------------------------------------------------------

const SPACE = /\s/;

// `texts`: the article's text nodes in order; `breaks`: indexes of nodes that
// begin a new block (a virtual space goes before them in `raw`).
// → { raw, nodeRaw, key, keyAt }: `key` is the text without whitespace and
// keyAt[k] = [node, offset] of its k-th character.
export function buildIndex(texts, breaks = []) {
  const breakSet = new Set(breaks);
  let raw = '';
  let key = '';
  const keyAt = [];
  const nodeRaw = [];
  texts.forEach((text, n) => {
    if (n > 0 && breakSet.has(n) && raw && !SPACE.test(raw[raw.length - 1])) raw += ' ';
    nodeRaw[n] = raw.length;
    for (let o = 0; o < text.length; o++) {
      if (SPACE.test(text[o])) continue;
      key += text[o];
      keyAt.push([n, o]);
    }
    raw += text;
  });
  return { raw, nodeRaw, key, keyAt };
}

// The text quote for a span between two [node, offset] points, or null.
export function describe(index, start, end) {
  const from = index.nodeRaw[start[0]] + start[1];
  const to = index.nodeRaw[end[0]] + end[1];
  const quote = collapse(index.raw.slice(from, to));
  if (!quote) return null;
  const prefix = index.raw.slice(Math.max(0, from - CONTEXT * 3), from).replace(/\s+/g, ' ').trimStart().slice(-CONTEXT);
  const suffix = index.raw.slice(to, to + CONTEXT * 3).replace(/\s+/g, ' ').trimEnd().slice(0, CONTEXT);
  return { quote, prefix, suffix };
}

// Finds a text quote again → { start: [node, offset], end: [node, offset] }
// or null. Among repeats of the quote, the one whose surroundings best match
// the prefix and suffix wins (the first on a tie).
export function findQuote(index, { quote, prefix, suffix }) {
  const q = strip(quote);
  if (!q) return null;
  const pre = strip(prefix);
  const post = strip(suffix);
  let best = -1;
  let bestScore = -1;
  for (let k = index.key.indexOf(q); k >= 0; k = index.key.indexOf(q, k + 1)) {
    const score = sharedEnd(index.key.slice(Math.max(0, k - pre.length), k), pre) +
      sharedStart(index.key.slice(k + q.length, k + q.length + post.length), post);
    if (score > bestScore) {
      best = k;
      bestScore = score;
    }
  }
  if (best < 0) return null;
  const last = index.keyAt[best + q.length - 1];
  return { start: index.keyAt[best], end: [last[0], last[1] + 1] };
}

function strip(s) {
  return String(s || '').replace(/\s+/g, '');
}

function collapse(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function sharedEnd(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function sharedStart(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

// ---------------------------------------------------------------------------
// The open article
// ---------------------------------------------------------------------------

let open = null;          // { id, item, root, page, list, margin }
let addButton = null;     // the floating Highlight button
let pop = null;           // { element, id } for the open popover
let status = null;        // quiet line at the foot of the screen
let statusTimer = null;
const cache = new Map();  // item id → highlights, as last fetched or changed here
let tempId = 0;

if (typeof window !== 'undefined') {
  window.addEventListener('compost:article', (e) => start(e.detail));
  window.addEventListener('compost:article-closed', stop);
}

async function start({ id, item, root }) {
  stop();
  const page = root.closest('.reader-page') || root.parentElement;
  open = { id, item, root, page, list: [], margin: el('aside', { className: 'hl-margin', 'aria-label': S.highlightsLabel }) };
  page.append(open.margin);
  root.addEventListener('click', onMarkClick);
  document.addEventListener('selectionchange', onSelection);
  window.addEventListener('resize', layoutMargin);
  open.resize = new ResizeObserver(() => layoutMargin());
  open.resize.observe(root);

  const known = cache.get(id);
  if (known) show(known);
  const list = await fetchList(id);
  if (!open || open.id !== id || !list) return;
  show(list);
}

function stop() {
  if (!open) return;
  open.root.removeEventListener('click', onMarkClick);
  document.removeEventListener('selectionchange', onSelection);
  window.removeEventListener('resize', layoutMargin);
  open.resize.disconnect();
  open.margin.remove();
  closePop();
  hideAdd();
  open = null;
}

async function fetchList(id) {
  try {
    const { status: code, data } = await api(`/api/items/${id}/highlights`);
    if (code !== 200) return null;
    cache.set(id, data.highlights);
    return data.highlights;
  } catch {
    return null; // offline: whatever the cache had stays on screen
  }
}

// Draws the highlights into the article: clears old marks, anchors each.
function show(list) {
  for (const mark of open.root.querySelectorAll('mark.hl')) unwrap(mark);
  open.root.normalize();
  open.list = list.map((h) => ({ ...h }));
  for (const h of open.list) h.anchored = anchor(h);
  renderMargin();
}

function anchor(h) {
  const { nodes, index } = articleIndex();
  const found = findQuote(index, h);
  if (!found) return false;
  wrap(nodes, found.start, found.end, h.id);
  return true;
}

// The article's text nodes, and the index over them.
function articleIndex() {
  const nodes = [];
  const walker = document.createTreeWalker(open.root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
  const breaks = [];
  let lastBlock = null;
  nodes.forEach((node, i) => {
    const block = blockOf(node);
    if (i > 0 && block !== lastBlock) breaks.push(i);
    lastBlock = block;
  });
  return { nodes, index: buildIndex(nodes.map((n) => n.data), breaks) };
}

const BLOCKS = new Set(['P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'FIGCAPTION', 'TD', 'TH', 'DT', 'DD', 'DIV', 'SECTION', 'ARTICLE']);
function blockOf(node) {
  let n = node.parentNode;
  while (n && n !== open.root && !BLOCKS.has(n.nodeName)) n = n.parentNode;
  return n;
}

// Wraps the text between two points in <mark class="hl">, one per text node,
// skipping whitespace-only nodes between blocks.
function wrap(nodes, start, end, id) {
  const pieces = [];
  for (let i = start[0]; i <= end[0]; i++) {
    const node = nodes[i];
    const s = i === start[0] ? start[1] : 0;
    const e = i === end[0] ? end[1] : node.data.length;
    if (e > s && node.data.slice(s, e).trim()) pieces.push([node, s, e]);
  }
  for (const [node, s, e] of pieces) {
    let target = node;
    if (s > 0) target = target.splitText(s);
    if (e - s < target.data.length) target.splitText(e - s);
    const mark = el('mark', { className: 'hl', dataset: { hl: String(id) } });
    target.parentNode.replaceChild(mark, target);
    mark.append(target);
  }
}

function unwrap(mark) {
  mark.replaceWith(...mark.childNodes);
}

function marksFor(id) {
  return [...open.root.querySelectorAll(`mark.hl[data-hl="${id}"]`)];
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

// The selection, if it lies in the article: { range } or null.
function articleSelection() {
  if (!open) return null;
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!open.root.contains(range.commonAncestorContainer)) return null;
  return range.toString().trim() ? range : null;
}

let selectionQueued = false;
function onSelection() {
  if (selectionQueued) return;
  selectionQueued = true;
  requestAnimationFrame(() => {
    selectionQueued = false;
    const range = articleSelection();
    if (range) showAdd(range);
    else hideAdd();
  });
}

function showAdd(range) {
  if (!addButton) {
    addButton = el('button', { type: 'button', className: 'hl-add' }, S.highlightAdd);
    addButton.addEventListener('pointerdown', (e) => e.preventDefault()); // keeps the selection
    addButton.addEventListener('mousedown', (e) => e.preventDefault());
    addButton.addEventListener('click', () => createFromSelection());
    document.body.append(addButton);
  }
  const rects = range.getClientRects();
  const box = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
  const first = rects.length ? rects[0] : box;
  // Below the selection on touch screens (the system menu sits above it).
  const touch = matchMedia('(pointer: coarse)').matches;
  const top = touch ? box.bottom + 10 : first.top - 40;
  const left = touch ? box.left : first.left;
  addButton.style.top = `${Math.max(4, top) + window.scrollY}px`;
  addButton.style.left = `${Math.min(window.innerWidth - 110, Math.max(8, left)) + window.scrollX}px`;
  addButton.hidden = false;
}

function hideAdd() {
  if (addButton) addButton.hidden = true;
}

// → the new highlight (optimistic), or null when nothing was selected.
function createFromSelection() {
  const range = articleSelection();
  if (!range) return null;
  const { nodes, index } = articleIndex();
  const points = rangePoints(range, nodes);
  const quote = points && describe(index, points.start, points.end);
  document.getSelection().removeAllRanges();
  hideAdd();
  if (!quote) return null;

  const h = { id: `t${++tempId}`, item_id: open.id, ...quote, note: null, starred: 0, created_at: Date.now(), anchored: true };
  wrap(nodes, points.start, points.end, h.id);
  open.list.push(h);
  renderMargin();
  save(h, open.id);
  return h;
}

// A range's ends as [node, offset] points over the article's text nodes.
function rangePoints(range, nodes) {
  let start = null;
  let end = null;
  nodes.forEach((node, i) => {
    if (!range.intersectsNode(node)) return;
    const s = node === range.startContainer ? range.startOffset : 0;
    const e = node === range.endContainer ? range.endOffset : node.data.length;
    if (!start) start = [i, s];
    end = [i, e];
  });
  return start ? { start, end } : null;
}

async function save(h, itemId) {
  const { quote, prefix, suffix, note } = h;
  let res = null;
  try {
    res = await api(`/api/items/${itemId}/highlights`, { quote, prefix, suffix, note });
  } catch {}
  const ok = res && res.status === 201;
  const local = open && open.id === itemId ? open.list.find((x) => x.id === h.id) : null;
  if (!ok) {
    if (local) {
      marksFor(h.id).forEach(unwrap);
      open.root.normalize();
      open.list = open.list.filter((x) => x !== local);
      renderMargin();
    }
    return say(S.highlightFailed);
  }
  const saved = res.data.highlight;
  if (local) {
    const pending = local.note !== note ? local.note : undefined;
    for (const mark of marksFor(h.id)) mark.dataset.hl = String(saved.id);
    if (pop && pop.id === h.id) pop.id = saved.id;
    Object.assign(local, saved);
    if (pending !== undefined) setNote(local, pending); // a note typed while the save was in flight
    renderMargin();
  }
  cache.set(itemId, [...(cache.get(itemId) || []).filter((x) => x.id !== saved.id), saved]);
  store.patchItem(itemId, { highlights: res.data.count });
}

// ---------------------------------------------------------------------------
// The popover: Note, Star as takeaway, Remove
// ---------------------------------------------------------------------------

function onMarkClick(e) {
  const mark = e.target.closest('mark.hl');
  if (!mark || articleSelection()) return;
  const id = mark.dataset.hl;
  openPop(open.list.find((h) => String(h.id) === id), mark);
}

function openPop(h, mark, editing = false) {
  closePop();
  if (!h) return;
  const element = el('div', { className: 'hl-pop', role: 'dialog', 'aria-label': S.highlightLabel });
  pop = { element, id: h.id };
  const action = (label, run, extra = {}) => {
    const b = el('button', { type: 'button', ...extra }, label);
    b.addEventListener('click', run);
    return b;
  };
  const note = h.note ? el('p', { className: 'hl-pop-note' }, h.note) : null;
  const buttons = el(
    'div',
    { className: 'hl-pop-actions' },
    action(h.note ? S.highlightEditNote : S.highlightNote, () => editNote()),
    action(h.starred ? S.highlightStarred : S.highlightStar, () => toggleStar(h), { 'aria-pressed': String(!!h.starred) }),
    action(S.highlightRemove, () => removeHighlight(h))
  );
  element.append(...[note, buttons].filter(Boolean));
  document.body.append(element);
  place(element, mark || marksFor(h.id)[0]);
  if (editing) editNote();

  function editNote() {
    const field = el('input', { type: 'text', maxLength: 500, value: h.note || '', 'aria-label': S.highlightNoteLabel, placeholder: S.highlightNoteLabel, enterKeyHint: 'done' });
    field.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      setNote(h, field.value.trim());
      closePop();
    });
    element.replaceChildren(field);
    field.focus();
  }
}

function place(element, mark) {
  if (!mark) return;
  const r = mark.getBoundingClientRect();
  element.style.top = `${r.bottom + 8 + window.scrollY}px`;
  const width = element.offsetWidth || 240;
  element.style.left = `${Math.min(window.innerWidth - width - 8, Math.max(8, r.left)) + window.scrollX}px`;
}

function closePop() {
  if (!pop) return;
  pop.element.remove();
  pop = null;
}

async function setNote(h, note) {
  const before = h.note;
  h.note = note || null;
  renderMargin();
  if (typeof h.id !== 'number') return; // sent once the highlight itself is saved
  const res = await send(`/api/highlights/${h.id}`, { note });
  if (!res) {
    h.note = before;
    renderMargin();
  } else remember(h);
}

async function toggleStar(h) {
  closePop();
  if (typeof h.id !== 'number') return;
  const starred = h.starred ? 0 : 1;
  const res = await send(`/api/highlights/${h.id}`, { starred: !!starred });
  if (!res) return;
  if (open) for (const other of open.list) if (other.item_id === h.item_id) other.starred = 0;
  h.starred = starred;
  remember(h);
  renderMargin();
  if (starred) say(S.highlightStarredStatus);
}

async function removeHighlight(h) {
  closePop();
  marksFor(h.id).forEach(unwrap);
  open.root.normalize();
  const itemId = open.id;
  open.list = open.list.filter((x) => x !== h);
  renderMargin();
  if (typeof h.id !== 'number') return;
  const res = await send(`/api/highlights/${h.id}/delete`, {});
  if (!res) {
    if (open && open.id === itemId) show([...open.list, h]); // back in, as it was
    return;
  }
  cache.set(itemId, (cache.get(itemId) || []).filter((x) => x.id !== h.id));
  store.patchItem(itemId, { highlights: res.count });
}

// POST with a quiet line on failure → data or null.
async function send(path, body) {
  try {
    const { status: code, data } = await api(path, body);
    if (code < 400) return data;
  } catch {}
  say(S.highlightFailed);
  return null;
}

// Keeps the cache in step with a changed highlight (and the one-star rule).
function remember(h) {
  const list = (cache.get(h.item_id) || []).map((x) => (x.id === h.id ? { ...x, note: h.note, starred: h.starred } : h.starred ? { ...x, starred: 0 } : x));
  cache.set(h.item_id, list);
}

// ---------------------------------------------------------------------------
// The margin (wide screens only)
// ---------------------------------------------------------------------------

function renderMargin() {
  if (!open) return;
  const items = open.list.filter((h) => h.anchored).map((h) => {
    const b = el(
      'button',
      { type: 'button', className: `hl-margin-item${h.starred ? ' starred' : ''}`, dataset: { hl: String(h.id) } },
      el('span', { className: 'hl-margin-quote' }, h.quote),
      h.note ? el('span', { className: 'hl-margin-note' }, h.note) : null
    );
    b.addEventListener('click', () => {
      const mark = marksFor(h.id)[0];
      if (!mark) return;
      mark.scrollIntoView({ block: 'center', behavior: 'instant' });
      openPop(h, mark);
    });
    return b;
  });
  open.margin.replaceChildren(...items);
  layoutMargin();
}

// Each entry sits level with its highlight, pushed down past the one above.
function layoutMargin() {
  if (!open) return;
  const pageRect = open.page.getBoundingClientRect();
  const room = window.innerWidth - pageRect.right;
  open.margin.hidden = room < MARGIN_MIN || !open.margin.children.length;
  if (open.margin.hidden) return;
  const entries = [...open.margin.children]
    .map((b) => ({ b, mark: marksFor(b.dataset.hl)[0] }))
    .filter((x) => x.mark)
    .map((x) => ({ ...x, top: x.mark.getBoundingClientRect().top - pageRect.top }))
    .sort((a, b) => a.top - b.top);
  let floor = 0;
  for (const { b, top } of entries) {
    const y = Math.max(top, floor);
    b.style.top = `${y}px`;
    floor = y + b.offsetHeight + 12;
  }
}

// ---------------------------------------------------------------------------
// Keys and the Esc ladder (called by reader.js)
// ---------------------------------------------------------------------------

// h highlights the selection; n notes it (or the open highlight); s stars the
// open highlight. True when it took the key.
export function highlightKey(key) {
  if (!open) return false;
  if (key === 'h') return !!createFromSelection();
  if (key === 'n') {
    const h = pop ? open.list.find((x) => x.id === pop.id) : createFromSelection();
    if (h) openPop(h, marksFor(h.id)[0], true);
    return !!h;
  }
  if (key === 's' && pop) {
    toggleStar(open.list.find((x) => x.id === pop.id));
    return true;
  }
  return false;
}

export function highlightBackOut() {
  if (pop) return closePop(), true;
  return false;
}

// ---------------------------------------------------------------------------
// Takeaway from a highlight: choices under the Done prompt (rack and reader)
// ---------------------------------------------------------------------------

// Small buttons, one per highlight; picking one stars it and puts its words
// in the takeaway field. With `prefill`, a starred highlight fills an empty
// field straight away.
export function takeawayChoices(item, field, { prefill = false } = {}) {
  const box = el('div', { className: 'hl-choices', hidden: true });
  const fill = (list) => {
    if (!list || !list.length) return;
    const buttons = list.map((h) => {
      const b = el('button', { type: 'button', className: 'hl-choice', 'aria-pressed': String(!!h.starred) }, h.quote);
      b.addEventListener('click', () => pick(h, b));
      return b;
    });
    box.replaceChildren(el('p', { className: 'hl-choices-label' }, S.takeawayFromHighlight), ...buttons);
    box.hidden = false;
    const starred = list.find((h) => h.starred);
    if (prefill && starred && !field.value) setField(starred.quote);
  };
  const setField = (text) => {
    field.value = text.slice(0, 500);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const pick = async (h, button) => {
    setField(h.quote);
    // Back to the field, so Enter keeps it (a touch keyboard stays down).
    if (!matchMedia('(pointer: coarse)').matches) field.focus();
    for (const b of box.querySelectorAll('.hl-choice')) b.setAttribute('aria-pressed', String(b === button));
    if (h.starred) return;
    const res = await send(`/api/highlights/${h.id}`, { starred: true });
    if (!res) return;
    h.starred = 1;
    remember(h);
    if (open && open.id === h.item_id) {
      for (const x of open.list) x.starred = x.id === h.id ? 1 : 0;
      renderMargin();
    }
  };

  const live = open && open.id === item.id ? open.list.filter((h) => typeof h.id === 'number') : null;
  const known = live || cache.get(item.id);
  if (known) fill(known);
  else if (item.highlights > 0) fetchList(item.id).then(fill);
  return box;
}

// ---------------------------------------------------------------------------

function say(text) {
  if (!status) {
    status = el('p', { className: 'hl-status', role: 'status', 'aria-live': 'polite' });
    document.body.append(status);
  }
  status.textContent = text;
  status.hidden = false;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (status.hidden = true), STATUS_MS);
}
