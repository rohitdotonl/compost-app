// The Rack tab: the add-link form, Continue Reading, and a grid of covers.
// Each cover is the row's title link; the ⋯ button under it opens a menu (a
// popover on desktop, an action sheet on phones) with everything else.
import { S } from './strings.js';
import { el } from './api.js';
import * as store from './store.js';
import { cover, decay, displayTitle, expiresToday, fade, timeLeft, untilDay } from './format.js';
import { takeawayChoices } from './highlights.js';

const DAY = 24 * 60 * 60 * 1000;
const PHONE = '(max-width: 599px)';
const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';

const ICON_LINK = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M8.5 11.5a3.5 3.5 0 0 0 5 0l2.5-2.5a3.5 3.5 0 0 0-5-5l-1 1"/><path d="M11.5 8.5a3.5 3.5 0 0 0-5 0L4 11a3.5 3.5 0 0 0 5 5l1-1"/></svg>';
const ICON_MORE = '<svg viewBox="0 0 20 20" fill="currentColor"><circle cx="4.5" cy="10" r="1.6"/><circle cx="10" cy="10" r="1.6"/><circle cx="15.5" cy="10" r="1.6"/></svg>';

function icon(markup, className = 'icon') {
  const span = el('span', { className, 'aria-hidden': 'true' });
  span.innerHTML = markup;
  return span;
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function createRackPanel() {
  const input = el('input', { type: 'url', placeholder: S.addPlaceholder, 'aria-label': S.addPlaceholder, required: true });
  const button = el('button', { type: 'submit' }, S.addSubmit);
  const form = el('form', { className: 'add' }, icon(ICON_LINK, 'add-icon'), input, button);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    addLink(input, button);
  });
  const resume = el('div', { className: 'continue', hidden: true });
  const list = el('ul', { className: 'list rack covers', 'aria-label': S.libRackLabel });
  const element = el('section', { className: 'panel rack-panel' }, form, resume, list);

  let takeawayDraft = '';    // survives re-renders while the prompt is open
  let lastPromptId = null;
  let shown = [];            // [id, li] as last rendered, in order
  const leaving = new Map(); // id → { node, beforeId } while a cover fades out
  let menuId = null;         // the item whose ⋯ menu is open
  let menuFresh = false;     // the menu opened on this render: animate it in
  let resumeDrawn = null;    // what the Continue Reading card shows

  // Outside presses close the menu. The phone sheet's scrim closes it on its
  // own click, so the tap doesn't land on a cover underneath.
  document.addEventListener('pointerdown', (e) => {
    if (menuId == null) return;
    const li = liFor(menuId);
    if (li && e.target.closest && e.target.closest('.menu, .more, .menu-scrim') && li.contains(e.target)) return;
    closeMenu(false);
  }, true);
  // Registered before keys.js (app.js builds the panels first), so Esc
  // closes the menu without also running the keyboard's back-out ladder.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || menuId == null) return;
    const menu = list.querySelector('.menu');
    if (!menu || !menu.getClientRects().length) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    closeMenu(true);
  }, true);
  window.addEventListener('hashchange', () => menuId != null && closeMenu(false));
  window.addEventListener('resize', () => menuId != null && placeMenu());

  function liFor(id) {
    return list.querySelector(`li.item[data-id="${id}"]:not(.leaving)`);
  }

  function openMenu(id) {
    menuId = id;
    menuFresh = true;
    render(store.getState());
    list.querySelector('.menu .menu-item')?.focus({ preventScroll: true });
  }

  function closeMenu(refocus) {
    const id = menuId;
    if (id == null) return;
    menuId = null;
    render(store.getState());
    if (refocus) liFor(id)?.querySelector('.more')?.focus({ preventScroll: true });
  }

  function render(state) {
    const now = Date.now();
    const items = store.rackItems(now);
    const ids = new Set(items.map((i) => i.id));
    if (menuId != null && (!ids.has(menuId) || state.promptId != null || element.hidden)) menuId = null;
    const promptFresh = state.promptId !== lastPromptId;
    const focus = focusKey();
    const before = positions();
    noticeLeavers(state, ids);
    shown = items.map((item) => [item.id, row(item, now, state, promptFresh)]);

    const children = [];
    for (const [id, li] of shown) {
      for (const ghost of leaving.values()) if (ghost.beforeId === id) children.push(ghost.node);
      children.push(li);
    }
    for (const ghost of leaving.values()) if (!ids.has(ghost.beforeId)) children.push(ghost.node);
    if (!children.length) children.push(el('li', { className: 'calm' }, S.rackEmpty, el('br'), el('a', { href: '#guide' }, S.guideLink)));
    list.replaceChildren(...children);
    renderContinue(items);
    restoreFocus(focus);
    if (menuId != null) placeMenu();
    menuFresh = false;
    flip(before);

    if (promptFresh) {
      lastPromptId = state.promptId;
      takeawayDraft = '';
      if (state.promptId) list.querySelector('.takeaway input')?.focus();
    }
  }

  // Rows are rebuilt on every state change; focus inside one comes back to
  // the same control in the new row.
  function focusKey() {
    const active = document.activeElement;
    if (!active || !list.contains(active)) return null;
    const li = active.closest('li.item');
    const control = active.closest('[data-act]');
    if (!li || !control) return null;
    return { id: li.dataset.id, act: control.dataset.act };
  }

  function restoreFocus(key) {
    if (!key) return;
    const li = list.querySelector(`li.item[data-id="${key.id}"]:not(.leaving)`);
    const node = li && li.querySelector(`[data-act="${key.act}"]`);
    if (!node) return;
    node.focus({ preventScroll: true });
    if (node.tagName === 'INPUT') node.setSelectionRange(node.value.length, node.value.length);
  }

  // Where each cover sat, relative to the grid, so the rest can glide into
  // place when one leaves or the order changes.
  function positions() {
    const map = new Map();
    if (element.hidden || reducedMotion()) return map;
    for (const li of list.children) {
      if (li.dataset.id && li.offsetWidth) map.set(li.dataset.id, [li.offsetLeft, li.offsetTop]);
    }
    return map;
  }

  function flip(before) {
    if (!before.size) return;
    for (const li of list.children) {
      const was = li.dataset.id && !li.classList.contains('leaving') && before.get(li.dataset.id);
      if (!was || li.querySelector('.takeaway-sheet, .menu')) continue;
      const dx = was[0] - li.offsetLeft;
      const dy = was[1] - li.offsetTop;
      if (Math.abs(dx) + Math.abs(dy) < 1) continue;
      li.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 380, easing: EASE });
    }
  }

  // A cover that has just gone to the Vault or the Heap (Done, Toss) fades
  // and shrinks away, unless reduced motion is asked for. Its old node stays
  // in the grid as an inert ghost until the animation ends.
  function noticeLeavers(state, ids) {
    if (reducedMotion()) return;
    shown.forEach(([id, li], index) => {
      if (ids.has(id) || leaving.has(id) || !leftJustNow(state.data, id)) return;
      if (!li.offsetHeight) return;
      const next = shown.slice(index + 1).find(([other]) => ids.has(other));
      for (const n of li.querySelectorAll('.menu, .menu-scrim, .takeaway-sheet, .sheet-scrim')) n.remove();
      li.classList.add('leaving');
      li.setAttribute('aria-hidden', 'true');
      li.setAttribute('aria-selected', 'false');
      li.inert = true;
      leaving.set(id, { node: li, beforeId: next ? next[0] : null });
      const anim = li.animate(
        [
          { opacity: 1, transform: 'none' },
          { opacity: 0, transform: 'scale(0.82) translateY(8px)' },
        ],
        { duration: 300, easing: 'cubic-bezier(0.4, 0, 0.7, 0.2)', fill: 'forwards' }
      );
      const finish = () => {
        leaving.delete(id);
        render(store.getState());
      };
      anim.finished.then(finish, finish);
    });
  }

  function row(item, now, state, promptFresh) {
    const lifespan = store.rules().lifespan;
    const bare = !item.image_url && !item.description;
    const title = displayTitle(item);
    const left = item.expires_at - now;
    const pct = Math.round((Number(item.progress) || 0) * 100);
    const isNew = !(item.progress > 0) && now - item.saved_at < DAY;

    const art = cover(item);
    art.style.setProperty('--decay', decay(left, lifespan).toFixed(2));
    art.style.setProperty('--fade', fade(left, lifespan));
    const link = el(
      'a',
      { className: 'title cover-link', href: item.url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': title, 'data-act': 'cover' },
      art,
      item.intent && S.intents[item.intent] ? el('span', { className: 'cover-badge', 'aria-hidden': 'true' }, S.intents[item.intent]) : null
    );

    let status = null;
    if (pct > 0) status = el('span', { className: 'pct', 'aria-label': S.libPercentLabel(pct) }, S.libPercent(pct));
    else if (isNew) status = el('span', { className: 'badge-new' }, S.libNew);
    else if (item.minutes) status = el('span', { className: 'mins' }, S.minutes(item.minutes));
    const open = menuId === item.id;
    const more = el(
      'button',
      { type: 'button', className: 'more', 'aria-label': S.libMore(title), 'aria-haspopup': 'dialog', 'aria-expanded': String(open), 'data-act': 'more' },
      icon(ICON_MORE)
    );
    more.addEventListener('click', () => (menuId === item.id ? closeMenu(true) : openMenu(item.id)));
    const info = el(
      'div',
      { className: 'info' },
      el(
        'div',
        { className: 'info-text' },
        status ? el('p', { className: 'info-top' }, status) : null,
        el('p', { className: `when${expiresToday(item.expires_at, now) ? ' soon' : ''}` }, timeLeft(item.expires_at, now))
      ),
      more
    );

    const li = el(
      'li',
      { className: `item${bare ? ' bare' : ''}${open ? ' menu-open' : ''}`, dataset: { id: String(item.id) }, 'aria-selected': String(state.selectedId === item.id) },
      link,
      info
    );
    if (open) li.append(...menu(item, bare, title));
    if (state.promptId === item.id) li.append(...takeawaySheet(item, title, promptFresh));
    return li;
  }

  // The ⋯ menu: what the row's action bar used to hold, with a header.
  function menu(item, bare, title) {
    const action = (act, label, run, className = '') => {
      const b = el('button', { type: 'button', className: `menu-item ${className}`.trim(), 'data-act': act }, label);
      b.addEventListener('click', () => {
        closeMenu(false);
        run();
      });
      return b;
    };
    const original = el('a', { className: 'menu-item', href: item.url, target: '_blank', rel: 'noopener noreferrer', 'data-act': 'm-original' }, S.libOpenOriginal);
    original.addEventListener('click', () => setTimeout(() => closeMenu(false)));

    const meta = [item.site, item.author, item.minutes ? S.minutes(item.minutes) : null].filter(Boolean).join(' · ');
    const head = el(
      'div',
      { className: 'menu-head' },
      cover(item, { size: 'sm' }),
      el(
        'div',
        { className: 'menu-head-text' },
        el('p', { className: 'menu-title' }, title),
        el('p', { className: 'meta' }, meta),
        item.description ? el('p', { className: 'menu-desc' }, item.description) : null,
        item.note ? el('p', { className: 'menu-note' }, item.note) : null
      )
    );

    const group = (...nodes) => el('div', { className: 'menu-group' }, ...nodes.filter(Boolean));
    const intents = el('div', { className: 'segmented intent-seg', role: 'group', 'aria-label': S.libWhen });
    for (const [value, label] of [...Object.entries(S.intents), ['', S.intentNone]]) {
      const b = el('button', { type: 'button', 'aria-pressed': String((item.intent || '') === value), 'data-act': `i-${value || 'none'}` }, label);
      b.addEventListener('click', () => store.setIntent(item.id, value || null));
      intents.append(b);
    }

    let refresh = null;
    if (bare) {
      refresh = el('button', { type: 'button', className: 'menu-item', 'data-act': 'm-refresh' }, S.refreshDetails);
      refresh.addEventListener('click', async () => {
        closeMenu(false);
        const updated = await store.refreshDetails(item.id);
        if (updated && !updated.image_url && !updated.description && updated.title === item.title) store.setStatus(S.refreshNothing);
      });
    }

    const box = el(
      'div',
      { className: `menu${menuFresh ? ' enter' : ''}`, role: 'dialog', 'aria-label': S.libMenuLabel(title) },
      el('div', { className: 'grabber', 'aria-hidden': 'true' }),
      head,
      group(action('m-read', S.libRead, () => store.open(item.id), 'strong'), original),
      group(
        action('m-done', S.done, () => store.beginDone(item.id)),
        item.extended ? null : action('m-extend', S.extend, () => store.extend(item.id)),
        action('m-toss', S.toss, () => store.toss(item.id), 'danger')
      ),
      el('div', { className: 'menu-intent' }, el('p', { className: 'menu-label' }, S.libWhen), intents),
      refresh ? group(refresh) : null
    );
    const scrim = el('div', { className: `menu-scrim${menuFresh ? ' enter' : ''}` });
    scrim.addEventListener('click', () => closeMenu(true));
    return [scrim, box];
  }

  // Desktop: the popover hangs under the cover's info row, kept inside the
  // grid and the window. Phones: CSS makes it a bottom sheet.
  function placeMenu() {
    const box = list.querySelector('.menu');
    if (!box) return;
    box.style.left = box.style.top = '';
    if (matchMedia(PHONE).matches) return;
    const li = box.parentElement;
    const lr = li.getBoundingClientRect();
    const gr = list.getBoundingClientRect();
    const width = box.offsetWidth;
    const height = box.offsetHeight;
    let x = lr.width - width;
    x = Math.max(gr.left - lr.left, Math.min(x, gr.right - lr.left - width));
    let y = li.querySelector('.info').offsetTop + li.querySelector('.info').offsetHeight + 4;
    const room = innerHeight - 12 - lr.top;
    if (y + height > room) y = Math.max(12 - lr.top, room - height);
    box.style.left = `${Math.round(x)}px`;
    box.style.top = `${Math.round(y)}px`;
  }

  function takeawaySheet(item, title, fresh) {
    const field = el('input', { type: 'text', maxLength: 500, value: takeawayDraft, 'aria-label': S.takeawayPrompt, enterKeyHint: 'done', 'data-act': 'tk-field' });
    field.addEventListener('input', () => (takeawayDraft = field.value));
    const keep = el('button', { type: 'submit', 'data-act': 'tk-keep' }, S.keep);
    const skip = el('button', { type: 'button', 'data-act': 'tk-skip' }, S.skip);
    const labelId = `takeaway-label-${item.id}`;
    const sheet = el(
      'form',
      { className: `takeaway takeaway-sheet${fresh ? ' enter' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': labelId },
      el('div', { className: 'grabber', 'aria-hidden': 'true' }),
      el(
        'div',
        { className: 'tk-head' },
        cover(item, { size: 'sm' }),
        el('div', { className: 'tk-head-text' }, el('p', { className: 'eyebrow' }, S.libTakeawayTitle), el('p', { className: 'tk-title' }, title))
      ),
      el('label', { id: labelId }, S.takeawayPrompt),
      field,
      takeawayChoices(item, field), // Phase 5: a highlight as the takeaway
      el('div', { className: 'tk-actions' }, skip, keep)
    );
    sheet.addEventListener('submit', (e) => {
      e.preventDefault();
      store.done(item.id, field.value.trim());
    });
    skip.addEventListener('click', () => store.done(item.id, ''));
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') store.cancelDone();
    });
    const scrim = el('div', { className: `sheet-scrim${fresh ? ' enter' : ''}` });
    scrim.addEventListener('click', () => store.cancelDone());
    return [scrim, sheet];
  }

  // The most recently read article that is part-way through.
  function renderContinue(items) {
    const item = items
      .filter((i) => i.progress > 0.01 && i.progress < 0.99)
      .sort((a, b) => (b.last_read_at || 0) - (a.last_read_at || 0))[0];
    const pct = item ? Math.round(item.progress * 100) : 0;
    const signature = item ? [item.id, pct, item.title, item.image_url, item.site].join('\u0001') : null;
    if (signature === resumeDrawn) return;
    resumeDrawn = signature;
    resume.hidden = !item;
    if (!item) return resume.replaceChildren();
    const go = el('button', { type: 'button', className: 'primary resume' }, S.libResume);
    go.addEventListener('click', () => store.open(item.id));
    const art = el('div', { className: 'continue-cover' }, cover(item, { size: 'sm' }));
    art.addEventListener('click', () => store.open(item.id));
    const bar = el('div', { className: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': S.libPercentLabel(pct) }, el('span'));
    bar.style.setProperty('--p', `${pct}%`);
    resume.replaceChildren(
      art,
      el(
        'div',
        { className: 'continue-body' },
        el('p', { className: 'eyebrow' }, S.libContinue),
        el('p', { className: 'continue-title' }, displayTitle(item)),
        el('p', { className: 'meta' }, `${item.site} · ${S.libPercentLabel(pct)}`),
        bar
      ),
      go
    );
  }

  async function addLink(field, submit) {
    const url = field.value.trim();
    if (!url) return;
    submit.disabled = true;
    const res = await store.add(url);
    submit.disabled = false;
    if (!res) return;
    if (res.status === 'saved') {
      field.value = '';
      store.setStatus(S.slotReceipt(res.used, res.limit, untilDay(res.item.expires_at)));
    } else if (res.status === 'in_rack') {
      field.value = '';
      store.setStatus(S.alreadyInRack);
    } else if (res.status === 'in_vault') {
      field.value = '';
      store.setStatus(S.alreadyInVault);
    } else if (res.status === 'full') {
      // The Save page owns the drop-one-to-make-room flow.
      location.href = `/save?url=${encodeURIComponent(url)}`;
    } else if (res.status === 'invalid_url') {
      store.setStatus(S.invalidLink);
    }
  }

  // Paste anywhere (keys.js) saves through the same flow and receipt.
  function addUrl(url) {
    input.value = url;
    addLink(input, button);
  }

  return { element, render, focusAdd: () => input.focus(), addUrl };
}

// True when a row left the rack by hand a moment ago: Done or Toss.
function leftJustNow(data, id) {
  const recent = (i) => i.id === id && i.ended_at > Date.now() - 5000;
  return data.vault.some(recent) || data.heap.some((i) => recent(i) && i.outcome === 'tossed');
}
