// The daily line at the top of the Rack (Phase 6): one older takeaway or
// starred highlight, set like an epigraph, with two quiet answers. The server
// pins the pick per local date, so every device shows the same line all day.
// Nothing here counts anything.
import { S } from './strings.js';
import { api, el } from './api.js';
import { shortDate } from './format.js';

const CACHE_KEY = 'compost.daily';
const FADE_MS = 400;

// The client's local date as YYYY-MM-DD; the server pins the pick to it.
export function localDay(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function createDaily() {
  const element = el('section', { className: 'daily', hidden: true, 'aria-label': S.dailyLabel });
  let shown = null; // { day, review } on screen

  // Fetches once per day (call it on open and when the page comes back).
  async function load() {
    const day = localDay();
    if (shown && shown.day === day) return;
    const cached = readCache();
    if (cached && cached.day === day) paint(cached);
    try {
      const { status, data } = await api(`/api/daily?day=${day}`);
      if (status !== 200) return;
      remember(data);
      paint(data);
    } catch {
      // Offline or locked out: the line is optional, so stay quiet.
    }
  }

  function paint(data) {
    shown = data;
    const r = data.review;
    element.hidden = !r;
    if (!r) return element.replaceChildren();
    const quote = el('blockquote', { className: 'daily-quote' }, `“${r.text}”`);
    if (r.answered) return element.replaceChildren(quote);

    const from = el(
      'p',
      { className: 'daily-from' },
      el('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, S.dailyFrom(r.title)),
      r.finished_at ? ` · ${S.dailyFinished(shortDate(r.finished_at))}` : ''
    );
    const button = (label, value) => {
      const b = el('button', { type: 'button', className: 'link' }, label);
      b.addEventListener('click', () => answer(value));
      return b;
    };
    const after = el(
      'div',
      { className: 'daily-after' },
      from,
      el('p', { className: 'daily-actions' }, button(S.dailyKeep, 'keep'), button(S.dailyLetGo, 'retire'))
    );
    element.replaceChildren(quote, after);
  }

  // Collapses to the quote at once; a failed request brings the buttons back.
  async function answer(value) {
    const data = shown;
    const answered = { ...data, review: { ...data.review, answered: true } };
    remember(answered);
    collapse(() => paint(answered));
    try {
      const { status } = await api(`/api/reviews/${data.review.id}`, { answer: value });
      if (status >= 400) throw new Error(String(status));
    } catch {
      remember(data);
      if (shown === answered) paint(data);
    }
  }

  function collapse(then) {
    const after = element.querySelector('.daily-after');
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!after || still) return then();
    after.classList.add('leaving');
    setTimeout(then, FADE_MS);
  }

  return { element, load };
}

function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)); } catch { return null; }
}

function remember(data) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch {}
}

// Phase 8: the Sunday line beneath the daily line, "You read for 3 h 10 min
// this week." Asked for on Sundays only; on any other day it isn't there.
export function createWeekly() {
  const element = el('p', { className: 'weekly', hidden: true });
  let checked = null; // the day last asked about

  async function load() {
    const now = new Date();
    const day = localDay(now);
    if (checked === day) return;
    checked = day;
    element.hidden = true;
    if (now.getDay() !== 0) return;
    try {
      const { status, data } = await api(`/api/weekly?day=${day}`);
      if (status !== 200 || !data.show) return;
      element.textContent = S.weeklyLine(S.weeklyTime(Math.max(1, Math.round(data.seconds / 60))));
      element.hidden = false;
    } catch {
      checked = null; // optional; try again on the next visit
    }
  }

  return { element, load };
}
