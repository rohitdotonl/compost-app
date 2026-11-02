// Weekly reading time (Phase 8): the reader's active seconds add up per
// local date, and on Sundays the Rack may show one line with the week's sum.
// No chart, no comparison, nothing on other days.
import { json } from './http.js';

export const MAX_SECONDS_PER_POST = 120; // the reader posts every 15s; more is bogus
export const WEEKLY_MIN_SECONDS = 60;    // below a minute the line stays away

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const routes = [['GET', '/api/weekly', getWeekly]];

// The day a progress post counts for: the client's local date, or the UTC
// date when it didn't send one.
export function readingDay(day, now) {
  return typeof day === 'string' && DAY_RE.test(day) ? day : new Date(now).toISOString().slice(0, 10);
}

// The statement that adds one post's seconds (clamped to 0–120), or null
// when there is nothing to add.
export function addSecondsStatement(db, day, seconds) {
  const s = Math.min(MAX_SECONDS_PER_POST, Math.max(0, Math.round(Number(seconds) || 0)));
  if (!s) return null;
  return db
    .prepare(`INSERT INTO reading_days (day, seconds) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET seconds = seconds + excluded.seconds`)
    .bind(day, s);
}

// GET /api/weekly?day=YYYY-MM-DD → { show, seconds }. Only on a Sunday, and
// only with at least a minute read across that day and the six before it.
async function getWeekly({ db, url }) {
  const day = url.searchParams.get('day') || '';
  if (!DAY_RE.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) return json({ error: 'invalid_day' }, 400);
  const date = new Date(`${day}T00:00:00Z`);
  if (date.getUTCDay() !== 0) return json({ show: false, seconds: 0 });
  const from = new Date(date.getTime() - 6 * 864e5).toISOString().slice(0, 10);
  const row = await db
    .prepare(`SELECT COALESCE(SUM(seconds), 0) AS s FROM reading_days WHERE day BETWEEN ? AND ?`)
    .bind(from, day)
    .first();
  return json({ show: row.s >= WEEKLY_MIN_SECONDS, seconds: row.s });
}
