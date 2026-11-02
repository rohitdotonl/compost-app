// The Vault drawn as a bookshelf (Phase 7): a grid of covers under a bold
// header per month, newest at the top. Each finished article is a "spine"
// button holding its cover, a little worn when it has highlights. The width
// and height helpers below are kept for the tests and other views.
//
// The pure helpers at the top are exported for tests/shelf.test.js. The view
// keeps its DOM between renders while the items are unchanged, so focus and
// the popover survive a selection change.
import { S } from './strings.js';
import { el } from './api.js';
import * as store from './store.js';
import { cover } from './format.js';

export const TINTS = 8;          // --tint-0 … --tint-7 in shelf.css
const WIDTH = { min: 18, max: 64, base: 18, perMinute: 3, unknown: 24 };

// 32-bit FNV-1a: small, stable across devices, good enough to spread sites.
export function hash(text) {
  let h = 0x811c9dc5;
  for (const ch of String(text)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// Pixel width for a reading time in minutes.
export function spineWidth(minutes) {
  if (!(Number(minutes) > 0)) return WIDTH.unknown;
  return Math.min(WIDTH.max, Math.max(WIDTH.min, Math.round(WIDTH.base + WIDTH.perMinute * minutes)));
}

// Index into the tint palette. www. and case don't change a site's colour.
export function siteHue(site) {
  const key = String(site || '').trim().toLowerCase().replace(/^www\./, '');
  return hash(key) % TINTS;
}

// Height as a share of the shelf, 0.86–1.00, so a row isn't a wall.
export function spineHeight(item) {
  return 0.86 + (hash(`${item.id}:${item.title}`) % 15) / 100;
}

// 0 for none, then 1–3 as highlights pile up. Purely cosmetic.
export function wear(highlights) {
  const n = Number(highlights) || 0;
  return n <= 0 ? 0 : n <= 2 ? 1 : n <= 5 ? 2 : 3;
}

// Items → [{ key: 'YYYY-MM', year, month, items }], newest month first and
// newest item first within a month (local time, like the rest of the app).
export function groupByMonth(items) {
  const groups = new Map();
  for (const item of items) {
    const d = new Date(finishedAt(item));
    const year = d.getFullYear();
    const month = d.getMonth();
    const key = `${year}-${String(month + 1).padStart(2, '0')}`;
    if (!groups.has(key)) groups.set(key, { key, year, month, items: [] });
    groups.get(key).items.push(item);
  }
  const sorted = [...groups.values()].sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  for (const g of sorted) g.items.sort((a, b) => finishedAt(b) - finishedAt(a) || b.id - a.id);
  return sorted;
}

function finishedAt(item) {
  return item.ended_at || item.saved_at || 0;
}

function monthLabel(group, now = new Date()) {
  const opts = group.year === now.getFullYear() ? { month: 'long' } : { month: 'long', year: 'numeric' };
  return new Date(group.year, group.month, 1).toLocaleDateString(undefined, opts);
}

function dayLabel(ms) {
  return new Date(ms).toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export function createShelf() {
  const tip = el('div', { className: 'spine-tip', role: 'tooltip', id: 'spine-tip', hidden: true });
  const shelves = el('ul', { className: 'shelves', 'aria-label': S.shelfLabel });
  const element = el('div', { className: 'bookshelf' }, shelves, tip);
  let drawn = null; // signature of what is on screen

  function render(items, selectedId) {
    const signature = items
      .map((i) => [i.id, i.title, i.site, i.minutes, i.ended_at, i.takeaway, i.highlights].join('\u0001'))
      .join('\u0002');
    if (signature !== drawn) {
      drawn = signature;
      hideTip();
      shelves.replaceChildren(...groupByMonth(items).map(shelf));
    }
    // A j/k press while a spine has focus moves the focus along with it.
    const active = document.activeElement;
    if (selectedId != null && active && active.classList.contains('spine') && Number(active.dataset.id) !== selectedId) {
      spineFor(selectedId)?.focus({ preventScroll: true });
    }
  }

  function shelf(group) {
    const labelId = `shelf-${group.key}`;
    return el(
      'li',
      { className: 'shelf-month' },
      el('h3', { className: 'shelf-label', id: labelId }, monthLabel(group)),
      el('ul', { className: 'shelf', 'aria-labelledby': labelId }, ...group.items.map((item) => el('li', {}, spine(item))))
    );
  }

  function spine(item) {
    const button = el(
      'button',
      {
        type: 'button',
        className: `spine tint-${siteHue(item.site)} wear-${wear(item.highlights)}`,
        dataset: { id: String(item.id) },
        'aria-label': S.spineLabel(item.title, item.site, dayLabel(finishedAt(item))),
        'aria-describedby': 'spine-tip',
      },
      cover(item)
    );
    button.addEventListener('click', () => {
      store.select(item.id);
      store.open(item.id);
    });
    button.addEventListener('focus', () => {
      if (store.getState().selectedId !== item.id) store.select(item.id);
      showTip(button, item);
    });
    button.addEventListener('blur', hideTip);
    button.addEventListener('mouseenter', () => showTip(button, item));
    // Back to the focused spine's popover, if one has focus.
    button.addEventListener('mouseleave', () => {
      const focused = document.activeElement;
      const found = focused && shelves.contains(focused) && store.locate(Number(focused.dataset.id));
      if (found) showTip(focused, found.item);
      else hideTip();
    });
    return button;
  }

  // The popover sits above the spine, inside the shelf's width.
  function showTip(button, item) {
    tip.replaceChildren(
      el('p', { className: 'spine-tip-title' }, item.title),
      el('p', { className: 'meta' }, `${item.site} · ${S.finishedOn(dayLabel(finishedAt(item)))}`)
    );
    if (item.takeaway) tip.append(el('p', { className: 'spine-tip-takeaway' }, item.takeaway));
    tip.hidden = false;
    const box = element.getBoundingClientRect();
    const b = button.getBoundingClientRect();
    const width = tip.offsetWidth;
    const left = Math.min(Math.max(0, b.left - box.left + b.width / 2 - width / 2), Math.max(0, box.width - width));
    let top = b.top - box.top - tip.offsetHeight - 8;
    if (top < 0) top = b.bottom - box.top + 8; // keeps clear of the search above
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  function hideTip() {
    tip.hidden = true;
  }

  function spineFor(id) {
    return shelves.querySelector(`.spine[data-id="${id}"]`);
  }

  // Arrow keys: left/right along a shelf, up/down to the nearest spine on the
  // row above or below (a wrapped shelf counts as rows). Returns true when
  // the key was used.
  function arrow(key) {
    const spines = [...shelves.querySelectorAll('.spine')];
    if (!spines.length) return false;
    const current = spineFor(store.getState().selectedId);
    let next = null;
    if (!current) next = key === 'ArrowUp' || key === 'ArrowLeft' ? spines[spines.length - 1] : spines[0];
    else if (key === 'ArrowLeft' || key === 'ArrowRight') {
      const row = [...current.closest('.shelf').querySelectorAll('.spine')];
      next = row[row.indexOf(current) + (key === 'ArrowRight' ? 1 : -1)] || current;
    } else if (key === 'ArrowUp' || key === 'ArrowDown') {
      next = vertical(spines, current, key === 'ArrowDown' ? 1 : -1) || current;
    } else return false;
    store.select(Number(next.dataset.id));
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: 'nearest' });
    return true;
  }

  function vertical(spines, current, dir) {
    const from = current.getBoundingClientRect();
    const x = from.left + from.width / 2;
    const rows = spines
      .map((s) => ({ s, r: s.getBoundingClientRect() }))
      .filter(({ r }) => (dir > 0 ? r.top >= from.bottom : r.bottom <= from.top));
    if (!rows.length) return null;
    // The nearest row is the one whose bottom edge (the shelf line) is closest.
    const target = dir > 0 ? Math.min(...rows.map(({ r }) => r.bottom)) : Math.max(...rows.map(({ r }) => r.bottom));
    const row = rows.filter(({ r }) => Math.abs(r.bottom - target) < 2);
    row.sort((a, b) => Math.abs(a.r.left + a.r.width / 2 - x) - Math.abs(b.r.left + b.r.width / 2 - x));
    return row[0].s;
  }

  return { element, render, arrow };
}
