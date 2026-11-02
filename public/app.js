// The main page's shell: passcode, header, tabs, status line and the router.
// Each tab is its own module; the state and the actions live in store.js.
// keys.js drives store.js from the keyboard and handles #vault?q=… and #item/N.
import { S } from './strings.js';
import { askPasscode, el, getPasscode, Unauthorized } from './api.js';
import * as store from './store.js';
import { createRackPanel } from './rack.js';
import { createVaultPanel } from './vault.js';
import { createHeapPanel } from './heap.js';
import { createGuidePanel } from './guide.js';
import { parseHash, startKeys } from './keys.js';
import { createReader } from './reader.js';
import { createDaily, createWeekly } from './daily.js';
import { createNotify } from './notify.js';

const TABS = ['rack', 'vault', 'heap', 'guide'];

// Tab icons: simple line drawings, 24×24, drawn for Compost.
const ICONS = {
  rack: '<path d="M4 4.5h4v15H4zM10 4.5h4v15h-4z"/><path d="M16.2 5.6l3.4-.9 3.1 13.9-3.4.9z"/>',
  vault: '<path d="M5 5.5A2.5 2.5 0 0 1 7.5 3H19v14.5H7.5A2.5 2.5 0 0 0 5 20z"/><path d="M5 20a1.5 1.5 0 0 0 1.5 1.5H19"/><path d="M9 7.5h6"/>',
  heap: '<path d="M12 21v-7.5"/><path d="M12 13.5c0-5 3.5-8.5 8.5-8.5 0 5-3.5 8.5-8.5 8.5z"/><path d="M12 16c0-4-2.8-6.5-7-6.5 0 4 2.8 6.5 7 6.5z"/>',
  guide: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.9.7c0 1.7-2.5 2.2-2.5 3.8"/><path d="M12 17h.01"/>',
  save: '<path d="M12 5v14M5 12h14"/>',
};

function icon(name) {
  const span = el('span', { className: 'icon', 'aria-hidden': 'true' });
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span.firstChild;
}
const root = document.getElementById('app');
let ui = null; // persistent elements, built once per unlock
let reader = null; // Phase 4: the reader at #read/42, built once
let daily = null; // the daily line at the top of the Rack (daily.js)
let weekly = null; // Phase 8: the Sunday reading-time line beneath it

async function start() {
  if (!getPasscode()) await askPasscode(root, S);
  buildShell();
  reader = createReader();
  store.setUnauthorizedHandler(relogin);
  store.subscribe(render);
  window.addEventListener('hashchange', () => render(store.getState()));
  startKeys({ panels: () => ui && ui.panels, currentTab, render: () => render(store.getState()) });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && ui) {
      refresh();
      daily.load();
      weekly.load();
    }
  });

  // Paint the last known list at once, then refresh behind it.
  const painted = store.paintFromCache();
  await refresh(!painted);
}

// Loads from the server. With nothing on screen yet, a failure shows a retry
// page; otherwise a quiet status line is enough.
async function refresh(firstPaint = false) {
  try {
    await store.load();
  } catch (err) {
    if (err instanceof Unauthorized) return relogin();
    if (!firstPaint) return store.setStatus(S.offline);
    root.replaceChildren(
      el('p', { className: 'calm' }, S.offline),
      el('button', { type: 'button', onclick: () => { buildShell(); refresh(true); } }, S.retry)
    );
  }
}

async function relogin() {
  ui = null;
  root.classList.remove('shell');
  store.forgetCache();
  await askPasscode(root, S, true);
  buildShell();
  await refresh(true);
}

// ---------------------------------------------------------------------------
// Shell: header, tabs, status line and one panel per tab
// ---------------------------------------------------------------------------

function buildShell() {
  const nav = el('nav', { className: 'tabs', 'aria-label': S.navLabel });
  const links = {};
  const counts = {};
  const brand = el('div', { className: 'brand' }, el('img', { src: '/icons/icon.svg', alt: '' }), S.appName);
  nav.append(brand, el('p', { className: 'nav-heading' }, S.navLibrary));
  for (const tab of TABS) {
    if (tab === 'guide') nav.append(el('p', { className: 'nav-heading' }, S.navHelp));
    counts[tab] = el('span', { className: 'count' });
    links[tab] = el('a', { href: `#${tab}` }, icon(tab), el('span', { className: 'label' }, tabName(tab)), counts[tab]);
    nav.append(links[tab]);
  }
  nav.append(el('span', { className: 'nav-extra' }, el('a', { href: '/bookmarklet' }, icon('save'), el('span', { className: 'label' }, S.bookmarkletLink))));
  const status = el('p', { className: 'status', role: 'status', 'aria-live': 'polite' });
  const panels = { rack: createRackPanel(), vault: createVaultPanel(), heap: createHeapPanel(), guide: createGuidePanel() };
  daily = createDaily();
  panels.rack.element.prepend(daily.element);
  daily.load();
  weekly = createWeekly();
  daily.element.after(weekly.element);
  weekly.load();
  const notify = createNotify(); // Phase 8: the daily reminder's footer line
  notify.load();
  const title = el('h1', {});
  const subtitle = el('p', { className: 'subtitle' });
  const header = el('header', { className: 'large-title' }, title, subtitle);
  const footer = el(
    'p',
    { className: 'footer' },
    el('a', { href: '#guide' }, S.guideLink), ' · ',
    el('a', { href: '/bookmarklet' }, S.bookmarkletLink)
  );
  const content = el('div', { className: 'content' }, header, ...TABS.map((t) => panels[t].element), footer, notify.element);
  root.classList.add('shell');
  root.replaceChildren(nav, content, status);
  ui = { links, counts, status, panels, title, subtitle };
  render(store.getState());
}

function tabName(tab) {
  return S[`tab${tab[0].toUpperCase()}${tab.slice(1)}`];
}

export function currentTab() {
  const tab = parseHash(location.hash).tab;
  return TABS.includes(tab) ? tab : 'rack';
}

function render(state) {
  if (reader) reader.render(state);
  if (!ui) return;
  renderStatus(state.status);
  if (!state.data) return;
  const tab = currentTab();
  renderTitle(state, tab);
  for (const t of TABS) {
    ui.panels[t].element.hidden = t !== tab;
    if (t === tab) ui.links[t].setAttribute('aria-current', 'page');
    else ui.links[t].removeAttribute('aria-current');
    ui.panels[t].render(state);
  }
}

// The large title and its quiet subtitle, plus the sidebar counts.
function renderTitle(state, tab) {
  const { rack, vault, heap } = state.data;
  const slots = store.rules().slots;
  ui.title.textContent = tabName(tab);
  ui.subtitle.textContent =
    tab === 'rack' ? S.slotsUsed(rack.length, slots) :
    tab === 'vault' ? S.vaultCount(vault.length) :
    tab === 'heap' ? S.heapCount(heap.length) : '';
  ui.counts.rack.textContent = `${rack.length}/${slots}`;
  ui.counts.vault.textContent = vault.length ? String(vault.length) : '';
  ui.counts.heap.textContent = heap.length ? String(heap.length) : '';
  document.title = tab === 'rack' ? S.appName : `${tabName(tab)} · ${S.appName}`;
}

let shownStatus = null;
function renderStatus(status) {
  if (status === shownStatus) return;
  shownStatus = status;
  if (!status) return ui.status.replaceChildren();
  const parts = [status.text];
  if (status.action) {
    const button = el('button', { type: 'button', className: 'link' }, status.action.label);
    button.addEventListener('click', () => {
      store.setStatus(null);
      status.action.run();
    });
    parts.push(' ', button);
  }
  ui.status.replaceChildren(...parts);
}

// ---------------------------------------------------------------------------

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
start();
