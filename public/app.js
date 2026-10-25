import { S } from './strings.js';
import { api, askPasscode, el, getPasscode, Unauthorized } from './api.js';

const DAY = 24 * 60 * 60 * 1000;
const TABS = ['rack', 'vault', 'heap'];

const root = document.getElementById('app');
let data = null;         // last GET /api/items response
let doneOpenId = null;   // rack item showing the takeaway prompt
let takeawayDraft = '';  // survives re-renders while the prompt is open
let vaultQuery = '';
let statusTimer = null;
let ui = null;           // persistent elements, built once

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function start() {
  if (!getPasscode()) await askPasscode(root, S);
  await load();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && ui) load();
  });
  window.addEventListener('hashchange', render);
}

async function load() {
  try {
    const res = await api('/api/items');
    data = res.data;
    if (!ui) buildShell();
    render();
  } catch (err) {
    if (err instanceof Unauthorized) {
      ui = null;
      await askPasscode(root, S, true);
      return load();
    }
    if (ui) return showStatus(S.offline);
    root.replaceChildren(
      el('p', { className: 'calm' }, S.offline),
      el('button', { type: 'button', onclick: load }, S.retry)
    );
  }
}

// Runs an API action, then reloads. Returns the response data.
async function act(path, body, button) {
  if (button) button.disabled = true;
  try {
    const { data: res } = await api(path, body ?? {});
    await load();
    return res;
  } catch (err) {
    if (err instanceof Unauthorized) return load();
    showStatus(S.offline);
    if (button) button.disabled = false;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shell: header, tabs, status line and one panel per tab
// ---------------------------------------------------------------------------

function buildShell() {
  const nav = el('nav', { className: 'tabs' });
  const links = {};
  for (const tab of TABS) {
    links[tab] = el('a', { href: `#${tab}` }, S[`tab${tab[0].toUpperCase()}${tab.slice(1)}`]);
    nav.append(links[tab]);
  }

  const status = el('p', { className: 'status', role: 'status', 'aria-live': 'polite' });

  // Rack: add link form
  const addInput = el('input', { type: 'url', placeholder: S.addPlaceholder, 'aria-label': S.addPlaceholder, required: true });
  const addButton = el('button', { type: 'submit' }, S.addSubmit);
  const addForm = el('form', { className: 'add row' }, addInput, addButton);
  addForm.addEventListener('submit', (e) => {
    e.preventDefault();
    addLink(addInput, addButton);
  });
  const rackList = el('ul', { className: 'list' });
  const rack = el('section', { className: 'panel' }, addForm, rackList);

  // Vault: search and download
  const search = el('input', { type: 'search', placeholder: S.vaultSearch, 'aria-label': S.vaultSearch });
  search.addEventListener('input', () => {
    vaultQuery = search.value;
    renderVault();
  });
  const download = el('a', { href: '#', className: 'quiet' }, S.vaultDownload);
  download.addEventListener('click', (e) => {
    e.preventDefault();
    downloadVault();
  });
  const vaultList = el('ul', { className: 'list' });
  const vault = el('section', { className: 'panel' }, el('div', { className: 'row' }, search), vaultList, el('p', { className: 'footer' }, download));

  // Heap
  const heapList = el('ul', { className: 'list' });
  const heap = el('section', { className: 'panel' }, el('p', { className: 'note' }, S.heapNote), heapList);

  const header = el('header', {}, el('h1', {}, S.appName), nav);
  const footer = el('p', { className: 'footer' }, el('a', { href: '/bookmarklet', className: 'quiet' }, S.bookmarkletLink));
  root.replaceChildren(header, status, rack, vault, heap, footer);
  ui = { links, status, addInput, panels: { rack, vault, heap }, rackList, vaultList, heapList };
}

function currentTab() {
  const tab = location.hash.slice(1);
  return TABS.includes(tab) ? tab : 'rack';
}

function render() {
  if (!ui || !data) return;
  const tab = currentTab();
  for (const t of TABS) {
    ui.panels[t].hidden = t !== tab;
    if (t === tab) ui.links[t].setAttribute('aria-current', 'page');
    else ui.links[t].removeAttribute('aria-current');
  }
  renderRack();
  renderVault();
  renderHeap();
}

function showStatus(text) {
  if (!ui) return;
  ui.status.textContent = text;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (ui.status.textContent = ''), 5000);
}

// ---------------------------------------------------------------------------
// Rack
// ---------------------------------------------------------------------------

function renderRack() {
  const now = Date.now();
  if (!data.rack.length) {
    ui.rackList.replaceChildren(el('li', { className: 'calm' }, S.rackEmpty));
    return;
  }
  ui.rackList.replaceChildren(...data.rack.map((item) => rackRow(item, now)));
}

function rackRow(item, now) {
  const meta = [item.site];
  if (item.minutes) meta.push(S.minutes(item.minutes));
  meta.push(timeLeft(item.expires_at, now));

  const row = el(
    'li',
    { className: 'item' },
    el('a', { className: 'title', href: item.url, target: '_blank', rel: 'noopener noreferrer' }, item.title),
    el('p', { className: 'meta' }, meta.join(' · '), item.intent ? el('span', { className: 'chip' }, S.intents[item.intent]) : null)
  );
  row.style.opacity = fade(item.expires_at - now, data.rules.lifespan);

  if (doneOpenId === item.id) {
    row.append(takeawayForm(item));
    return row;
  }

  const doneBtn = el('button', { type: 'button' }, S.done);
  doneBtn.addEventListener('click', () => {
    doneOpenId = item.id;
    takeawayDraft = '';
    renderRack();
    ui.rackList.querySelector('.takeaway input')?.focus();
  });
  const tossBtn = el('button', { type: 'button' }, S.toss);
  tossBtn.addEventListener('click', async () => {
    const res = await act(`/api/items/${item.id}/toss`, {}, tossBtn);
    if (res && res.ok) showStatus(S.tossed);
  });
  const actions = el(
    'div',
    { className: 'actions' },
    el('a', { className: 'button', href: item.url, target: '_blank', rel: 'noopener noreferrer' }, S.open),
    doneBtn,
    tossBtn
  );
  if (!item.extended) {
    const extendBtn = el('button', { type: 'button' }, S.extend);
    extendBtn.addEventListener('click', () => act(`/api/items/${item.id}/extend`, {}, extendBtn));
    actions.append(extendBtn);
  }
  row.append(actions);
  return row;
}

function takeawayForm(item) {
  const input = el('input', { type: 'text', maxLength: 500, value: takeawayDraft, 'aria-label': S.takeawayPrompt, enterKeyHint: 'done' });
  input.addEventListener('input', () => (takeawayDraft = input.value));
  const keep = el('button', { type: 'submit' }, S.keep);
  const skip = el('button', { type: 'button' }, S.skip);
  const form = el(
    'form',
    { className: 'takeaway' },
    el('label', {}, S.takeawayPrompt),
    el('div', { className: 'row' }, input, keep, skip)
  );
  const finish = async (takeaway) => {
    keep.disabled = skip.disabled = true;
    doneOpenId = null;
    const res = await act(`/api/items/${item.id}/done`, takeaway ? { takeaway } : {});
    if (res && res.ok) showStatus(S.slotFreed(res.used, res.limit));
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    finish(input.value.trim());
  });
  skip.addEventListener('click', () => finish(''));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      doneOpenId = null;
      renderRack();
    }
  });
  return form;
}

async function addLink(input, button) {
  const url = input.value.trim();
  if (!url) return;
  const res = await act('/api/items', { url }, button);
  button.disabled = false;
  if (!res) return;
  if (res.status === 'saved') {
    input.value = '';
    showStatus(S.savedReceipt(res.used, res.limit, weekday(res.item.expires_at)));
  } else if (res.status === 'in_rack') {
    input.value = '';
    showStatus(S.alreadyInRack);
  } else if (res.status === 'in_vault') {
    input.value = '';
    showStatus(S.alreadyInVault);
  } else if (res.status === 'full') {
    // The Save page owns the drop-one-to-make-room flow.
    location.href = `/save?url=${encodeURIComponent(url)}`;
  } else if (res.status === 'invalid_url') {
    showStatus(S.invalidLink);
  }
}

// Full opacity with a full lifespan left, about 40% on the last day.
function fade(msLeft, lifespan) {
  const t = Math.min(1, Math.max(0, (msLeft - DAY) / (lifespan - DAY)));
  return (0.4 + 0.6 * t).toFixed(2);
}

function timeLeft(expiresAt, now) {
  const days = Math.round((startOfDay(expiresAt) - startOfDay(now)) / DAY);
  if (days <= 0) return S.expiresToday;
  if (days === 1) return S.expiresTomorrow;
  return S.daysLeft(days);
}

function startOfDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function weekday(ms) {
  return new Date(ms).toLocaleDateString(undefined, { weekday: 'long' });
}

function shortDate(ms) {
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

function renderVault() {
  if (!data.vault.length) {
    ui.vaultList.replaceChildren(el('li', { className: 'calm' }, S.vaultEmpty));
    return;
  }
  const q = vaultQuery.trim().toLowerCase();
  const items = q
    ? data.vault.filter((i) => [i.title, i.site, i.url, i.takeaway].some((f) => f && f.toLowerCase().includes(q)))
    : data.vault;
  if (!items.length) {
    ui.vaultList.replaceChildren(el('li', { className: 'calm' }, S.vaultNoMatch));
    return;
  }
  ui.vaultList.replaceChildren(
    ...items.map((item) =>
      el(
        'li',
        { className: 'item' },
        el('a', { className: 'title', href: item.url, target: '_blank', rel: 'noopener noreferrer' }, item.title),
        el('p', { className: 'meta' }, `${item.site} · ${S.finishedOn(shortDate(item.ended_at))}`),
        item.takeaway ? el('blockquote', {}, item.takeaway) : null
      )
    )
  );
}

function downloadVault() {
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const lines = [`# ${S.vaultFileTitle}`, '', S.vaultFileExported(iso(Date.now())), ''];
  for (const item of data.vault) {
    const title = item.title.replace(/([\\[\]])/g, '\\$1');
    lines.push(`## [${title}](${item.url.replace(/\)/g, '%29')})`, '', `${item.site} · ${S.finishedOn(iso(item.ended_at))}`, '');
    if (item.takeaway) lines.push(`> ${item.takeaway}`, '');
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `compost-vault-${iso(Date.now())}.md` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------------------
// Heap
// ---------------------------------------------------------------------------

function renderHeap() {
  if (!data.heap.length) {
    ui.heapList.replaceChildren(el('li', { className: 'calm' }, S.heapEmpty));
    return;
  }
  ui.heapList.replaceChildren(
    ...data.heap.map((item) =>
      el(
        'li',
        { className: 'item' },
        el('p', { className: 'title' }, item.title),
        el('a', { className: 'url', href: item.url, target: '_blank', rel: 'noopener noreferrer' }, item.url),
        el('p', { className: 'meta' }, S.leftOn(shortDate(item.ended_at)))
      )
    )
  );
}

// ---------------------------------------------------------------------------

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
start();
