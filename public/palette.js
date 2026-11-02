// The command palette (⌘K / Ctrl+K): one field that finds items across Rack,
// Vault and Heap from the data already in memory, and runs commands by name.
// Enter goes to an item (switches tab and selects it); ⌘/Ctrl+Enter also
// opens it. Built once, reused on every open.
import { S } from './strings.js';
import { el } from './api.js';
import * as store from './store.js';
import { hasTerms, parseQuery, scoreItem, scoreLabel } from './search.js';
import { exportJson, exportMarkdown, exportObsidian } from './export.js';

const LIMIT = 12;
const SECTIONS = ['commands', 'rack', 'vault', 'heap'];

let ui = null;
let ctx = null;          // hooks from keys.js
let results = [];        // what is listed, in display order
let active = 0;
let returnFocus = null;

export function isPaletteOpen() {
  return Boolean(ui && ui.root.isConnected);
}

export function openPalette(hooks) {
  ctx = hooks;
  if (!ui) ui = build();
  returnFocus = document.activeElement;
  ui.input.value = '';
  update();
  document.body.append(ui.root);
  ui.input.focus();
}

// `restore` puts focus back where it was; after running something it stays
// on the page, so the next shortcut works straight away.
export function closePalette(restore = true) {
  if (!isPaletteOpen()) return;
  ui.root.remove();
  if (restore && returnFocus && returnFocus.isConnected && returnFocus !== document.body) returnFocus.focus();
  else if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
}

function build() {
  const input = el('input', {
    type: 'text',
    className: 'palette-input',
    placeholder: S.palettePlaceholder,
    'aria-label': S.paletteLabel,
    autocomplete: 'off',
    spellcheck: false,
    role: 'combobox',
    'aria-expanded': 'true',
    'aria-controls': 'palette-list',
  });
  const list = el('ul', { id: 'palette-list', className: 'palette-list', role: 'listbox' });
  const box = el('div', { className: 'palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': S.paletteLabel }, input, list);
  const root = el('div', { className: 'overlay' }, box);
  root.addEventListener('mousedown', (e) => {
    if (e.target === root) closePalette();
  });
  input.addEventListener('input', update);
  input.addEventListener('keydown', onKey);
  list.addEventListener('click', (e) => {
    const li = e.target.closest('[data-index]');
    if (li) run(results[Number(li.dataset.index)], e.metaKey || e.ctrlKey);
  });
  return { root, input, list };
}

function onKey(e) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!results.length) return;
    active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
    paint();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (results[active]) run(results[active], e.metaKey || e.ctrlKey);
  } else if (e.key === 'Tab') {
    e.preventDefault(); // keep focus in the sheet
  }
}

// ---------------------------------------------------------------------------
// Finding
// ---------------------------------------------------------------------------

function update() {
  results = find(ui.input.value.trim());
  active = 0;
  paint();
}

function find(query) {
  const parsed = parseQuery(query);
  const filtered = parsed.site || parsed.intent || parsed.before != null || parsed.after != null;
  const found = [];
  for (const command of commands()) {
    const score = !query ? 1 : filtered ? 0 : scoreLabel(command.label, query);
    if (score) found.push({ ...command, section: 'commands', score });
  }
  const data = store.getState().data;
  if (query && data && hasTerms(parsed)) {
    const lists = { rack: store.rackItems(), vault: data.vault, heap: data.heap };
    for (const tab of ['rack', 'vault', 'heap']) {
      for (const item of lists[tab]) {
        const score = scoreItem(item, parsed);
        if (score) found.push({ section: tab, item, score });
      }
    }
  }
  // Best first, then grouped under their section in a fixed order.
  const top = found.sort((a, b) => b.score - a.score).slice(0, LIMIT);
  return SECTIONS.flatMap((s) => top.filter((r) => r.section === s));
}

// Commands that make sense right now. Row commands act on the selection.
function commands() {
  const C = S.commands;
  const state = store.getState();
  const selected = state.selectedId != null ? store.locate(state.selectedId) : null;
  const list = [];
  if (selected) {
    const { item } = selected;
    list.push({ label: C.open, hint: item.title, run: () => window.open(item.url, '_blank', 'noopener') });
    if (selected.tab === 'rack') {
      list.push({ label: C.done, hint: item.title, run: () => { ctx.go('rack'); store.beginDone(item.id); } });
      list.push({ label: C.toss, hint: item.title, run: () => store.toss(item.id) });
      if (!item.extended) list.push({ label: C.extend, hint: item.title, run: () => store.extend(item.id) });
    }
  }
  const tab = ctx.currentTab();
  if (tab !== 'rack') list.push({ label: C.goRack, run: () => ctx.go('rack') });
  if (tab !== 'vault') list.push({ label: C.goVault, run: () => ctx.go('vault') });
  if (tab !== 'heap') list.push({ label: C.goHeap, run: () => ctx.go('heap') });
  list.push({ label: C.add, run: () => ctx.focusAdd() });
  if (state.data) {
    list.push({ label: C.exportMarkdown, run: () => exportMarkdown(state.data) });
    list.push({ label: C.exportJson, run: () => exportJson(state.data) });
    list.push({ label: C.exportObsidian, run: () => exportObsidian(state.data) });
  }
  // Last, so a bare Enter never tosses anything.
  const oldest = store.rackItems().reduce((a, b) => (!a || b.saved_at < a.saved_at ? b : a), null);
  if (oldest) list.push({ label: C.tossOldest, hint: oldest.title, run: () => store.toss(oldest.id) });
  list.push({ label: C.bookmarklet, run: () => ctx.copy(bookmarkletCode(location.origin), S.bookmarkletCopied) });
  list.push({ label: C.shortcuts, run: () => ctx.shortcuts() });
  return list;
}

// Same code as the bookmarklet page shows (bookmarklet.js).
function bookmarkletCode(origin) {
  return `javascript:(()=>{window.open('${origin}/save?url='+encodeURIComponent(location.href),` +
    `'compost','width=440,height=620')})()`;
}

function run(result, openIt) {
  // Adding needs the focus it asks for; everything else leaves the page focused.
  closePalette(false);
  if (result.item) {
    ctx.reveal(result.item.id);
    if (openIt) store.open(result.item.id);
  } else {
    result.run();
  }
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

function paint() {
  const nodes = [];
  let section = null;
  results.forEach((r, i) => {
    if (r.section !== section) {
      section = r.section;
      nodes.push(el('li', { className: 'palette-section', role: 'presentation' }, S.sections[section]));
    }
    const li = el('li', { className: 'palette-option', role: 'option', id: `palette-${i}`, dataset: { index: String(i) }, 'aria-selected': String(i === active) });
    if (r.item) {
      const sub = [r.item.site];
      if (r.item.takeaway) sub.push(r.item.takeaway);
      li.append(el('span', { className: 'palette-title' }, r.item.title), el('span', { className: 'palette-sub' }, sub.join(' · ')));
    } else {
      li.append(el('span', { className: 'palette-command' }, r.label));
      if (r.hint) li.append(el('span', { className: 'palette-sub' }, r.hint));
    }
    nodes.push(li);
  });
  if (!nodes.length) nodes.push(el('li', { className: 'palette-empty', role: 'presentation' }, S.paletteNothing));
  ui.list.replaceChildren(...nodes);
  if (results.length) {
    ui.input.setAttribute('aria-activedescendant', `palette-${active}`);
    ui.list.querySelector(`#palette-${active}`).scrollIntoView({ block: 'nearest' });
  } else {
    ui.input.removeAttribute('aria-activedescendant');
  }
}
