// The end of an article (Phase 5): the page stack at the foot of the screen,
// finish detection and the stamp.
//
// The page stack is a thin pile of page edges that thins as you read, with a
// tick for each section heading. No percentage anywhere.
//
// Finishing means reaching the end at a plausible pace: the last few percent
// of the article come into view after at least FINISH_SHARE of its reading
// time was spent actively reading (or FINISH_UNKNOWN seconds when the length
// is unknown). Flicking to the bottom does not count. Then, once per open, an
// ink stamp with the date lands at the foot of the article and the takeaway
// prompt slides up. Enter accepts, Esc dismisses (reader.js). The only
// celebration in the app; under reduced motion it simply appears.
import { S } from './strings.js';
import { el } from './api.js';
import * as store from './store.js';
import { currentArticle, openTakeaway } from './reader.js';

const FINISH_SHARE = 0.4;    // of the estimated reading time
const FINISH_UNKNOWN = 20;   // seconds, for an article with no estimate
const END_SHARE = 0.05;      // "the end": the last 5% of the article in view
const STACK_EDGES = 5;       // page edges in a full stack

let state = null; // { id, item, root, stack, pages, ticks, wasAtEnd, stamped, observer }

if (typeof window !== 'undefined') {
  window.addEventListener('compost:article', (e) => begin(e.detail));
  window.addEventListener('compost:progress', (e) => onProgress(e.detail));
  window.addEventListener('compost:article-closed', end);
}

// The pure parts, for the tests.
export function finishThreshold(minutes) {
  return minutes > 0 ? FINISH_SHARE * minutes * 60 : FINISH_UNKNOWN;
}

export function hasFinished({ atEnd, arrived, activeSeconds, minutes }) {
  return atEnd && arrived && activeSeconds >= finishThreshold(minutes);
}

// The stack's thickness in page edges, STACK_EDGES down to 1.
export function stackEdges(progress) {
  return 1 + (STACK_EDGES - 1) * (1 - Math.min(1, Math.max(0, progress)));
}

function begin({ id, item, root }) {
  end();
  const reader = root.closest('.reader');
  const ticks = el('div', { className: 'page-stack-ticks' });
  const pages = el('div', { className: 'page-stack-pages' }, ticks);
  const stack = el('div', { className: 'page-stack', 'aria-hidden': 'true' }, pages);
  reader.append(stack);
  state = { id, item, root, stack, pages, ticks, wasAtEnd: true, stamped: false, stamp: null };
  // Headings and images move as the page settles, so ticks follow the size.
  state.observer = new ResizeObserver(() => drawTicks());
  state.observer.observe(root);
  const progress = currentArticle()?.progress ?? 0;
  drawStack(progress);
  state.wasAtEnd = atEnd(); // already at the end on open (a resume, a short page) is no arrival
  state.timer = setInterval(checkUnscrollable, 2000);
}

function end() {
  if (!state) return;
  state.observer.disconnect();
  clearInterval(state.timer);
  state.stack.remove();
  if (state.stamp) state.stamp.remove();
  state = null;
}

function onProgress({ id, progress, activeSeconds }) {
  if (!state || state.id !== id) return;
  drawStack(progress);
  const now = atEnd();
  const arrived = now && !state.wasAtEnd;
  state.wasAtEnd = now;
  if (!state.stamped && hasFinished({ atEnd: now, arrived, activeSeconds, minutes: state.item.minutes })) finish();
}

// A page too short to scroll never "arrives": it finishes on time alone.
function checkUnscrollable() {
  if (!state || state.stamped) return;
  if (document.documentElement.scrollHeight - window.innerHeight > 8) return;
  const article = currentArticle();
  if (article && hasFinished({ atEnd: true, arrived: true, activeSeconds: article.activeSeconds, minutes: state.item.minutes })) finish();
}

function atEnd() {
  const rect = state.root.getBoundingClientRect();
  return rect.height > 0 && rect.bottom - rect.height * END_SHARE <= window.innerHeight;
}

// ---------------------------------------------------------------------------
// The end moment
// ---------------------------------------------------------------------------

function finish() {
  // Only a rack article can be finished; the Vault's are already kept.
  if (!store.rackItem(state.id)) return;
  state.stamped = true;
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const date = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  state.stamp = el(
    'div',
    { className: `stamp${calm ? '' : ' landing'}`, role: 'img', 'aria-label': S.stampLabel(date) },
    el('span', { className: 'stamp-word' }, S.stampWord),
    el('span', { className: 'stamp-date' }, date)
  );
  state.root.after(state.stamp);
  const touch = matchMedia('(pointer: coarse)').matches;
  openTakeaway({ slide: !calm, focus: !touch });
  // Brings the prompt up into view under the stamp.
  const foot = state.root.closest('.reader-page')?.querySelector('.reader-end');
  if (foot) requestAnimationFrame(() => foot.scrollIntoView({ block: 'center', behavior: calm ? 'auto' : 'smooth' }));
  if (touch && navigator.vibrate) {
    try { navigator.vibrate(15); } catch {}
  }
}

// ---------------------------------------------------------------------------
// The page stack
// ---------------------------------------------------------------------------

function drawStack(progress) {
  state.pages.style.setProperty('--edges', stackEdges(progress).toFixed(2));
  for (const tick of state.ticks.children) tick.classList.toggle('passed', Number(tick.dataset.at) <= progress);
}

// One tick per h2, placed where scrolling reaches it (same measure as progress).
function drawTicks() {
  if (!state) return;
  const max = document.documentElement.scrollHeight - window.innerHeight;
  const headings = [...state.root.querySelectorAll('h2')];
  const progress = currentArticle()?.progress ?? 0;
  state.ticks.replaceChildren(
    ...headings.map((h) => {
      const top = h.getBoundingClientRect().top + window.scrollY - window.innerHeight * 0.3;
      const at = max > 0 ? Math.min(1, Math.max(0, top / max)) : 0;
      const tick = el('span', { className: `page-stack-tick${at <= progress ? ' passed' : ''}`, dataset: { at: at.toFixed(4) } });
      tick.style.left = `${(at * 100).toFixed(2)}%`;
      return tick;
    })
  );
}
