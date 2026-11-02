// Keyboard shortcuts, paste-to-save and linkable views (#vault?q=…, #item/42).
// Everything drives store.js; the keymap is the switch in press(). Keys are
// ignored while typing in a field, except Esc and ⌘K / Ctrl+K.
import { S } from './strings.js';
import { el } from './api.js';
import * as store from './store.js';
import { closePalette, isPaletteOpen, openPalette } from './palette.js';
import { isReading, readerBackOut, readerKey } from './reader.js';

const TABS = ['rack', 'vault', 'heap'];
const CHORD_TABS = { r: 'rack', v: 'vault', h: 'heap' };
const INTENTS = { 1: 'tonight', 2: 'commute', 3: 'weekend' };
const CHORD_MS = 1200;
const NOT_TYPING = ['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'];

// '#vault?q=site:x' → { tab: 'vault', q: 'site:x', item: null }; '#item/42' → { item: 42 }
export function parseHash(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  const item = /^item\/(\d+)$/.exec(raw);
  if (item) return { tab: null, q: '', item: Number(item[1]) };
  const [tab, query = ''] = raw.split('?');
  return { tab, q: new URLSearchParams(query).get('q') || '', item: null };
}

export function isTyping(node) {
  if (!node || !node.tagName) return false;
  if (node.isContentEditable || node.tagName === 'TEXTAREA' || node.tagName === 'SELECT') return true;
  return node.tagName === 'INPUT' && !NOT_TYPING.includes(node.type);
}

let app = null;          // { panels(), currentTab(), render() } from app.js
let chordAt = 0;         // when 'g' was pressed
let sheet = null;        // the shortcut sheet, while open
let pendingItem = null;  // #item/N waiting for its data
let lastTab = null;
let lastIndex = -1;      // where the selection was, for when its row leaves
let scrolledId = null;

export function startKeys(hooks) {
  app = hooks;
  window.addEventListener('keydown', onKeydown, true);
  document.addEventListener('paste', onPaste);
  window.addEventListener('hashchange', applyRoute);
  store.subscribe(afterRender);
  applyRoute();
}

const panels = () => app && app.panels();

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

function onKeydown(e) {
  if (!panels()) return; // passcode screen
  const mod = e.metaKey || e.ctrlKey;
  if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
    stop(e);
    if (isPaletteOpen()) closePalette();
    else showPalette();
    return;
  }
  if (e.key === 'Escape') {
    if (backOut()) stop(e);
    return;
  }
  if (isPaletteOpen() || mod || e.altKey || e.isComposing || isTyping(e.target)) return;
  if (sheet && e.key !== '?') return;
  if (isReading() && e.key !== '?') return void (readerKey(e.key) && e.preventDefault()); // Phase 4: rack keys are off while reading
  if (press(e.key, e.target)) e.preventDefault();
}

function stop(e) {
  e.preventDefault();
  e.stopPropagation();
}

// Returns true when the key did something.
function press(key, target) {
  if (chordAt) {
    const fresh = Date.now() - chordAt < CHORD_MS;
    chordAt = 0;
    if (fresh && CHORD_TABS[key]) return go(CHORD_TABS[key]), true;
  }
  // A panel laid out in two dimensions (the Vault's shelf) takes the arrows.
  const panel = panels()[app.currentTab()];
  if (key.startsWith('Arrow') && panel.arrow && panel.arrow(key)) return true;
  const state = store.getState();
  const id = state.selectedId;
  const rackId = id != null && store.rackItem(id) ? id : null;

  switch (key) {
    case 'j':
    case 'ArrowDown':
      return move(1);
    case 'k':
    case 'ArrowUp':
      return move(-1);
    case 'Enter':
      if (target && target.closest && target.closest('a, button, summary')) return false;
    // falls through
    case 'o':
      if (id != null) store.open(id);
      return id != null;
    case 'd':
      if (rackId != null) store.beginDone(rackId);
      return rackId != null;
    case 'x':
      if (rackId != null) store.toss(rackId);
      return rackId != null;
    case 'u':
      return undo();
    case 'e':
      if (rackId == null && id != null && store.locate(id)?.tab === 'vault') return panels().vault.editTakeaway(id), true;
      if (rackId == null) return false;
      if (store.rackItem(rackId).extended) store.setStatus(S.alreadyExtended);
      else store.extend(rackId);
      return true;
    case 'c':
      if (id == null) return false;
      copy(store.locate(id).item.url, S.linkCopied);
      return true;
    case 'a':
      focusAdd();
      return true;
    case '/':
      return focusSearch();
    case 'g':
      chordAt = Date.now();
      return true;
    case '1':
    case '2':
    case '3': {
      if (rackId == null) return false;
      const intent = INTENTS[key];
      store.setIntent(rackId, store.rackItem(rackId).intent === intent ? null : intent);
      return true;
    }
    case '?':
      if (sheet) closeSheet();
      else openSheet();
      return true;
  }
  return false;
}

// Esc: palette, then sheet, then the reader, then the takeaway prompt, then a focused field,
// then the selection. One level per press.
function backOut() {
  if (isPaletteOpen()) return closePalette(), true;
  if (sheet) return closeSheet(), true;
  if (readerBackOut()) return true; // Phase 4: the reader's own levels, then back to the rack
  const state = store.getState();
  if (state.promptId != null) return store.cancelDone(), true;
  const active = document.activeElement;
  if (isTyping(active)) return active.blur(), true;
  if (chordAt) return (chordAt = 0), true;
  if (state.selectedId != null) return store.select(null), true;
  return false;
}

function move(delta) {
  const ids = visibleIds();
  if (!ids.length) return false;
  store.moveSelection(delta, ids);
  return true;
}

function undo() {
  const status = store.getState().status;
  if (!status || !status.action || status.action.label !== S.undo) return false;
  store.setStatus(null);
  status.action.run();
  return true;
}

// Switches tab now rather than on the next hashchange, so a key pressed right
// after (g v then /) finds the panel already showing.
export function go(tab) {
  if (app.currentTab() === tab && location.hash === `#${tab}`) return;
  location.hash = `#${tab}`;
  app.render();
}

function focusAdd() {
  go('rack');
  panels().rack.focusAdd();
}

function focusSearch() {
  const tab = app.currentTab();
  if (tab === 'rack') return focusAdd(), true;
  if (tab === 'vault') return panels().vault.focusSearch(), true;
  showPalette(); // the Heap has no field of its own
  return true;
}

export function copy(text, done) {
  const ok = () => store.setStatus(done);
  const fail = () => store.setStatus(S.copyFailed);
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(ok, fail);
  else fail();
}

// ---------------------------------------------------------------------------
// Selection on screen
// ---------------------------------------------------------------------------

function rows(tab) {
  const panel = panels() && panels()[tab];
  // A row sliding out (rack.js) is a ghost: it no longer holds the selection.
  return panel ? [...panel.element.querySelectorAll('[data-id]:not(.leaving)')] : [];
}

function visibleIds() {
  return rows(app.currentTab()).map((r) => Number(r.dataset.id));
}

// Runs after each render: marks the selected row, scrolls it into view once,
// and when its row has left (done, tossed, filtered out) moves to the row
// that took its place. A tab switch clears it.
function afterRender(state) {
  if (!state.data || !panels()) return;
  if (pendingItem != null) return queueMicrotask(resolveItem);
  const tab = app.currentTab();
  const shown = rows(tab);
  const ids = shown.map((r) => Number(r.dataset.id));
  const index = state.selectedId == null ? -1 : ids.indexOf(state.selectedId);
  if (state.selectedId != null && index < 0) {
    const next = tab === lastTab && lastIndex >= 0 && ids.length ? ids[Math.min(lastIndex, ids.length - 1)] : null;
    lastTab = tab;
    lastIndex = -1;
    queueMicrotask(() => store.select(next));
    return;
  }
  lastTab = tab;
  lastIndex = index;
  for (const t of TABS) {
    for (const r of rows(t)) r.setAttribute('aria-selected', String(t === tab && Number(r.dataset.id) === state.selectedId));
  }
  if (index < 0) scrolledId = null;
  else if (scrolledId !== state.selectedId) {
    scrolledId = state.selectedId;
    shown[index].scrollIntoView({ block: 'nearest' });
  }
}

// Shows an item wherever it lives: switches tab, clears a Vault search that
// hides it, selects it.
export function reveal(id) {
  const found = store.locate(id);
  if (!found) return;
  scrolledId = null;
  if (found.tab === 'vault' && !rows('vault').some((r) => Number(r.dataset.id) === id)) {
    panels().vault.setQuery('');
  }
  if (app.currentTab() !== found.tab || location.hash !== `#${found.tab}`) {
    history.pushState(null, '', `#${found.tab}`);
  }
  lastTab = found.tab;
  store.select(id);
}

// ---------------------------------------------------------------------------
// Linkable views
// ---------------------------------------------------------------------------

function applyRoute() {
  const route = parseHash(location.hash);
  pendingItem = route.item;
  if (route.tab === 'vault' && route.q && panels()) panels().vault.setQuery(route.q);
  resolveItem();
}

// #item/42 becomes #vault (or wherever it lives) with the row selected.
function resolveItem() {
  if (pendingItem == null || !store.locate(pendingItem)) return;
  const id = pendingItem;
  pendingItem = null;
  history.replaceState(null, '', `#${store.locate(id).tab}`);
  reveal(id);
}

// ---------------------------------------------------------------------------
// Paste anywhere to save
// ---------------------------------------------------------------------------

function onPaste(e) {
  if (!panels() || isPaletteOpen() || isTyping(document.activeElement)) return;
  const text = ((e.clipboardData && e.clipboardData.getData('text')) || '').trim();
  if (!/^https?:\/\/\S+$/i.test(text)) return;
  e.preventDefault();
  panels().rack.addUrl(text);
}

// ---------------------------------------------------------------------------
// Palette and shortcut sheet
// ---------------------------------------------------------------------------

function showPalette() {
  if (sheet) closeSheet();
  openPalette({ currentTab: app.currentTab, go, reveal, focusAdd, copy, shortcuts: openSheet });
}

function openSheet() {
  if (sheet) return;
  const list = el('dl', { className: 'keysheet-list' });
  for (const [keys, does] of S.shortcuts) list.append(el('dt', {}, el('kbd', {}, keys)), el('dd', {}, does));
  const close = el('button', { type: 'button', className: 'link' }, S.close);
  close.addEventListener('click', closeSheet);
  const box = el(
    'div',
    { className: 'keysheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': S.shortcutsTitle, tabIndex: -1 },
    el('h2', {}, S.shortcutsTitle),
    list,
    el('p', { className: 'keysheet-close' }, close)
  );
  sheet = el('div', { className: 'overlay' }, box);
  sheet.addEventListener('mousedown', (e) => {
    if (e.target === sheet) closeSheet();
  });
  document.body.append(sheet);
  box.focus();
}

function closeSheet() {
  if (!sheet) return;
  sheet.remove();
  sheet = null;
}
