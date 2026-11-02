// The Guide tab: what Compost does and how to use it, step by step.
// createGuidePanel() returns { element, render(state) }. All copy is in
// strings.js (S.guide, S.shortcuts); the illustrations are small HTML/CSS
// drawings, hidden from screen readers since the text says the same thing.
import { S } from './strings.js';

const G = S.guide;
const DAY = 864e5;
const HOUR = 36e5;
const DAILY_AFTER = 20; // src/rules.js MIN_VAULT_FOR_DAILY

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style') node.setAttribute('style', v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const d = (cls, ...kids) => h('div', { class: cls }, ...kids);
const s = (cls, text) => h('span', { class: cls, text });
const cover = (hue, extra = '', style = '') => h('span', { class: `gi-cover ${extra}`.trim(), style: `--hue:${hue};${style}` }, s('gi-cover-line'), s('gi-cover-line short'));
const lines = (n, cls = '') => Array.from({ length: n }, (_, i) => s(`gi-line ${cls} ${i === n - 1 ? 'end' : ''}`.trim()));

// One drawing per step, keyed by step id.
const ILLO = {
  start: () => d('gi-stage gi-start',
    d('gi-phone',
      d('gi-phone-screen',
        s('gi-app-mark', 'C'),
        s('gi-small', G.illo.passcode),
        d('gi-dots', s('gi-dot on'), s('gi-dot on'), s('gi-dot on'), s('gi-dot')),
        s('gi-pill accent', G.illo.unlock))),
    d('gi-sheet gi-share',
      d('gi-sheet-row', s('gi-sq'), s('', G.illo.copy)),
      d('gi-sheet-row is-picked', s('gi-sq plus', '+'), s('', G.illo.addHome)),
      d('gi-sheet-row', s('gi-sq'), s('', G.illo.share)))),

  save: () => d('gi-stage gi-save',
    d('gi-field', s('gi-placeholder', G.illo.paste), s('gi-pill accent', G.illo.add)),
    d('gi-browser',
      d('gi-browser-bar', s('gi-dot'), s('gi-dot'), s('gi-dot'), s('gi-url')),
      d('gi-bookmarks', s('gi-bm'), s('gi-bm accent', S.bookmarkletName), s('gi-bm')),
      d('gi-browser-body', ...lines(3))),
    d('gi-keys', h('kbd', { text: 'Alt' }), s('gi-plus', '+'), h('kbd', { text: 'Shift' }), s('gi-plus', '+'), h('kbd', { text: 'S' }))),

  rack: () => {
    const hues = [18, 200, 140, 280, 40, 330, 100, 230, 60, 170];
    return d('gi-stage gi-rack',
      d('gi-grid', hues.map((hue, i) => {
        const age = i / (hues.length - 1);
        const c = cover(hue, i === 7 ? 'has-badge' : '', `--age:${age.toFixed(2)}`);
        if (i === 7) c.append(s('gi-badge', G.hours(48)));
        return c;
      })),
      d('gi-chips', Object.values(S.intents).map((t, i) => s(`gi-chip ${i === 0 ? 'on' : ''}`, t))));
  },

  read: () => d('gi-stage gi-read',
    d('gi-page',
      d('gi-page-top', s('gi-back', '‹'), s('gi-aa', G.illo.settings)),
      s('gi-page-title'), s('gi-page-title short'),
      ...lines(6)),
    d('gi-sheet gi-aa-sheet',
      d('gi-aa-row', s('gi-seg', 'A−'), s('gi-seg big', 'A+')),
      d('gi-aa-row', s('gi-seg serif on', S.readerFonts.serif), s('gi-seg', S.readerFonts.sans)),
      d('gi-aa-row', s('gi-swatch light on'), s('gi-swatch sepia'), s('gi-swatch dark')))),

  mark: () => d('gi-stage gi-mark',
    d('gi-page flat',
      s('gi-line'), s('gi-line'),
      d('gi-hl-wrap',
        d('gi-pop', s('', S.highlightAdd), s('', S.highlightNote), s('star', '★')),
        s('gi-line hl')),
      s('gi-line hl short'), s('gi-line'), s('gi-line end')),
    d('gi-keys', (G.steps.find((x) => x.id === 'mark').keys || []).map(([k]) => h('kbd', { text: k })))),

  finish: () => d('gi-stage gi-finish',
    d('gi-card',
      s('gi-small strong', G.illo.takeaway),
      d('gi-input', s('gi-line'), s('gi-caret')),
      d('gi-card-foot', s('gi-pill', S.skip), s('gi-pill accent', G.illo.keep))),
    d('gi-stamp', s('', G.illo.read)),
    d('gi-toast', s('', G.illo.tossed), s('gi-toast-act', G.illo.undo))),

  vault: () => d('gi-stage gi-vault',
    d('gi-search', s('gi-glass'), s('gi-token', 'site:'), s('gi-q', 'nytimes.com')),
    d('gi-shelf',
      [24, 200, 140, 300, 50, 180, 260, 90, 10, 220].map((hue, i) =>
        h('span', { class: 'gi-spine', style: `--hue:${hue};--h:${[78, 92, 70, 86, 96, 74, 88, 80, 94, 72][i]}%` }))),
    d('gi-shelf-board'),
    d('gi-chips', [S.exportMarkdown, S.exportJson, S.exportObsidian].map((t) => s('gi-chip', t)))),

  heap: () => d('gi-stage gi-heap',
    d('gi-pile',
      cover(20, 'grey', '--r:-9deg;--x:-34px'),
      cover(200, 'grey', '--r:7deg;--x:30px'),
      cover(120, 'grey', '--r:-2deg;--x:0px')),
    s('gi-pill quiet', G.illo.clears)),

  extras: () => d('gi-stage gi-extras',
    d('gi-card quote',
      s('gi-small', G.illo.daily),
      d('gi-quote', s('gi-line'), s('gi-line end')),
      d('gi-card-foot', s('gi-pill', S.dailyKeep), s('gi-pill', S.dailyLetGo))),
    s('gi-weekly', G.illo.weekly),
    d('gi-reminder', s('gi-bell'), s('', G.illo.reminder), s('gi-switch'))),
};

function keysTable() {
  return h('table', { class: 'guide-keys' },
    h('caption', { class: 'visually-hidden', text: G.keysCaption }),
    h('thead', { class: 'visually-hidden' }, h('tr', {}, h('th', { scope: 'col', text: G.keyCol }), h('th', { scope: 'col', text: G.actionCol }))),
    h('tbody', {}, S.shortcuts.map(([keys, what]) =>
      h('tr', {},
        h('th', { scope: 'row' }, keyCaps(keys)),
        h('td', { text: what })))));
}

// "g r / v / h" -> <kbd>g</kbd> <kbd>r</kbd> / <kbd>v</kbd> ...
function keyCaps(text) {
  const out = [];
  text.split(' ').forEach((part, i) => {
    if (i) out.push(' ');
    out.push(part === '/' && text !== '/' ? s('guide-or', '/') : h('kbd', { text: part }));
  });
  return out;
}

function ctxFrom(state) {
  const r = (state && state.data && state.data.rules) || {};
  return {
    slots: r.slots || 10,
    days: Math.round((r.lifespan || 7 * DAY) / DAY),
    ext: G.hours(Math.round((r.extension || 48 * HOUR) / HOUR)),
    daily: DAILY_AFTER,
  };
}

export function createGuidePanel() {
  const element = h('section', { class: 'panel guide', 'aria-labelledby': 'guide-title' });
  const dynamic = []; // [node, fn] pairs for copy that names the rules' numbers
  const text = (tag, cls, value) => {
    const node = h(tag, { class: cls });
    if (typeof value === 'function') dynamic.push([node, value]);
    else node.textContent = value;
    return node;
  };

  const hero = h('header', { class: 'guide-hero' },
    d('guide-hero-art', [[18, -14, -26], [200, -4, -8], [140, 6, 12], [40, 16, 30]].map(([hue, r, x]) =>
      cover(hue, 'hero', `--r:${r}deg;--x:${x}px`))),
    d('guide-hero-text',
      text('p', 'guide-kicker', G.kicker),
      h('h2', { id: 'guide-title', class: 'guide-title', text: G.title }),
      text('p', 'guide-intro', G.intro)));

  const indexList = h('ol', {});
  const index = h('nav', { class: 'guide-index', 'aria-label': G.indexLabel }, indexList);
  const steps = h('ol', { class: 'guide-steps' });
  const indexButtons = [];

  G.steps.forEach((step, i) => {
    const anchor = `guide-step-${step.id}`;
    const btn = h('button', {
      type: 'button',
      class: 'guide-index-item',
      onclick: () => {
        const target = element.querySelector(`#${anchor}`);
        const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
        target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
        target.querySelector('h3').focus({ preventScroll: true });
      },
    }, s('guide-index-num', String(i + 1)), s('guide-index-name', step.title));
    indexButtons.push(btn);
    indexList.append(h('li', {}, btn));

    const body = d('guide-step-text',
      s('guide-step-num', G.stepWord(i + 1)),
      h('h3', { tabindex: '-1', text: step.title }),
      step.body.map((p) => text('p', '', p)));
    if (step.search) body.append(d('guide-tokens', step.search.map((t) => h('code', { text: t }))));
    if (step.link) body.append(h('a', { class: 'guide-link', href: step.link.href, text: `${step.link.text} →` }));

    const isKeys = step.id === 'keys';
    const figure = isKeys ? keysTable() : h('figure', { class: 'guide-illo', 'aria-hidden': 'true' }, ILLO[step.id]());
    steps.append(h('li', { class: `guide-step${isKeys ? ' wide' : ''}`, id: anchor }, body, figure));
  });

  element.append(hero, d('guide-layout', index, steps));

  // Mark the step in view in the index.
  if ('IntersectionObserver' in window) {
    const seen = new Map();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) seen.set(e.target, e.isIntersecting ? e.boundingClientRect.top : null);
      let best = null;
      let bestTop = Infinity;
      for (const [el, top] of seen) if (top != null && top < bestTop) { best = el; bestTop = top; }
      if (!best) return;
      const at = [...steps.children].indexOf(best);
      indexButtons.forEach((b, i) => {
        if (i === at) b.setAttribute('aria-current', 'step');
        else b.removeAttribute('aria-current');
      });
    }, { rootMargin: '-15% 0px -55% 0px' });
    [...steps.children].forEach((li) => io.observe(li));
  }

  let last = '';
  function render(state) {
    const ctx = ctxFrom(state);
    const key = JSON.stringify(ctx);
    if (key === last) return;
    last = key;
    for (const [node, fn] of dynamic) node.textContent = fn(ctx);
  }
  render(null);
  return { element, render };
}
