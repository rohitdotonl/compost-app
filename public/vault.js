// The Vault tab: finished articles with their takeaways, search and export.
import { S } from './strings.js';
import { el } from './api.js';
import * as store from './store.js';
import { cover, displayTitle, shortDate } from './format.js';
import { matches, parseQuery } from './search.js';
import { exportJson, exportMarkdown, exportObsidian } from './export.js';
import { createShelf } from './shelf.js';

const VIEW_KEY = 'compost.vaultView'; // 'list' or 'shelf', per device

function savedView() {
  try { return localStorage.getItem(VIEW_KEY) === 'shelf' ? 'shelf' : 'list'; } catch { return 'list'; }
}

export function createVaultPanel() {
  let query = '';
  const search = el('input', { type: 'search', placeholder: S.vaultSearch, 'aria-label': S.vaultSearch });
  const glass = el('span', { className: 'search-icon', 'aria-hidden': 'true' });
  glass.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="8.6" cy="8.6" r="5.6"/><path d="m13 13 4 4"/></svg>';
  const searchBox = el('label', { className: 'search' }, glass, search);
  search.addEventListener('input', () => {
    query = search.value;
    // Keeps the search linkable as #vault?q=…
    history.replaceState(null, '', query.trim() ? `#vault?q=${encodeURIComponent(query.trim())}` : '#vault');
    render(store.getState());
  });
  const exportLink = (label, run) => {
    const a = el('a', { href: '#', className: 'quiet' }, label);
    a.addEventListener('click', (e) => {
      e.preventDefault();
      run(store.getState().data);
    });
    return a;
  };
  const download = el(
    'span',
    { className: 'quiet' },
    `${S.exportLabel} `,
    exportLink(S.exportMarkdown, exportMarkdown), ' · ',
    exportLink(S.exportJson, exportJson), ' · ',
    exportLink(S.exportObsidian, exportObsidian)
  );
  const list = el('ul', { className: 'list vault-list' });
  // Phase 7: List / Shelf
  let view = savedView();
  const shelf = createShelf();
  const viewLink = (name, label) => {
    const b = el('button', { type: 'button' }, label);
    b.addEventListener('click', () => {
      view = name;
      try { localStorage.setItem(VIEW_KEY, name); } catch {}
      render(store.getState());
    });
    return b;
  };
  const views = { list: viewLink('list', S.viewList), shelf: viewLink('shelf', S.viewShelf) };
  const toggle = el('div', { className: 'segmented view-toggle', role: 'group', 'aria-label': S.viewLabel }, views.list, views.shelf);
  let editingId = null; // Vault row whose takeaway is being rewritten (Phase 6)
  let draft = '';       // its text, kept across re-renders
  let rendering = false;
  const element = el(
    'section',
    { className: 'panel' },
    el('div', { className: 'vault-bar' }, searchBox, toggle),
    list,
    shelf.element,
    el('p', { className: 'footer' }, download)
  );

  function render(state) {
    for (const [name, b] of Object.entries(views)) b.setAttribute('aria-pressed', String(name === view));
    const vault = state.data.vault;
    const items = vault.filter((i) => matches(i, parseQuery(query)));
    const onShelf = view === 'shelf' && items.length > 0;
    shelf.element.hidden = !onShelf;
    if (onShelf) {
      // Only the spines carry data-id while the shelf shows, for keys.js.
      list.replaceChildren();
      shelf.render(items, state.selectedId);
      return;
    }
    shelf.render([], null);
    if (!vault.length) return list.replaceChildren(el('li', { className: 'calm' }, S.vaultEmpty));
    if (!items.length) return list.replaceChildren(el('li', { className: 'calm' }, S.vaultNoMatch));
    rendering = true;
    list.replaceChildren(...items.map(row));
    rendering = false;
    const field = list.querySelector('.takeaway-edit');
    if (field && document.activeElement !== field) {
      field.focus();
      field.setSelectionRange(draft.length, draft.length);
    }
  }

  // The takeaway is what was earned, so it leads, in the serif, beside a
  // small cover; the title and site follow, small.
  function row(item) {
    const thumb = el('a', { className: 'title thumb-link', href: item.url, target: '_blank', rel: 'noopener noreferrer', tabIndex: -1, 'aria-hidden': 'true' }, cover(item, { size: 'sm' }));
    return el(
      'li',
      { className: `item vault-item${item.takeaway ? '' : ' no-takeaway'}`, dataset: { id: String(item.id) } },
      thumb,
      el(
        'div',
        { className: 'vault-body' },
        editingId === item.id ? takeawayField(item) : item.takeaway ? takeawayQuote(item) : null,
        el('a', { className: 'title', href: item.url, target: '_blank', rel: 'noopener noreferrer' }, displayTitle(item)),
        el('p', { className: 'meta' }, `${item.site} · ${item.outcome === 'kept' ? S.keptUnfinished : S.finishedOn(shortDate(item.ended_at))}`)
      )
    );
  }

  // Click the takeaway (or press e on the row) to rewrite it: Enter saves, Esc cancels.
  function takeawayQuote(item) {
    const quote = el('blockquote', { className: 'takeaway-text editable', title: S.takeawayEdit }, item.takeaway);
    quote.addEventListener('click', () => editTakeaway(item.id));
    return quote;
  }

  function takeawayField(item) {
    const field = el('input', { type: 'text', className: 'takeaway-edit', maxLength: 500, value: draft, 'aria-label': S.takeawayEdit, enterKeyHint: 'done' });
    const finish = (save) => {
      if (editingId !== item.id) return;
      editingId = null;
      if (save && draft.trim() !== (item.takeaway || '')) store.editTakeaway(item.id, draft.trim());
      else render(store.getState());
    };
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    field.addEventListener('input', () => (draft = field.value));
    field.addEventListener('blur', () => rendering || finish(false));
    return field;
  }

  function editTakeaway(id) {
    const item = store.getState().data.vault.find((i) => i.id === id);
    if (!item) return;
    editingId = id;
    draft = item.takeaway || '';
    render(store.getState());
    list.querySelector('.takeaway-edit')?.select();
  }

  function setQuery(q) {
    search.value = query = q;
    if (store.getState().data) render(store.getState());
  }

  // Arrow keys on the shelf (keys.js asks first); false lets j/k handling run.
  const arrow = (key) => view === 'shelf' && !shelf.element.hidden && shelf.arrow(key);

  return { element, render, focusSearch: () => search.focus(), setQuery, arrow, editTakeaway };
}
