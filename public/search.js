// Search shared by the Vault field and the palette. Pure functions, no DOM.
//
//   site:nytimes.com  intent:weekend  before:2026-09  after:2026-03  words…
//
// Every token must hold (AND). Plain words match the title, site, takeaway
// and note. before/after compare the date an item left the rack (or was
// saved, for rack items) with whole months, both exclusive: before:2026-09
// means before 1 September, after:2026-09 means from 1 October on.

const FILTERS = ['site', 'intent', 'before', 'after'];

// Returns { site, intent, before, after, words }. Dates become ms bounds;
// a malformed date is kept as a plain word so it simply matches nothing odd.
export function parseQuery(query) {
  const parsed = { site: null, intent: null, before: null, after: null, words: [] };
  for (const token of String(query || '').toLowerCase().split(/\s+/)) {
    if (!token) continue;
    const colon = token.indexOf(':');
    const key = colon > 0 ? token.slice(0, colon) : '';
    const value = colon > 0 ? token.slice(colon + 1) : '';
    if (!FILTERS.includes(key) || !value) {
      parsed.words.push(token);
    } else if (key === 'before') {
      const range = monthRange(value);
      if (range) parsed.before = range.start;
      else parsed.words.push(token);
    } else if (key === 'after') {
      const range = monthRange(value);
      if (range) parsed.after = range.end;
      else parsed.words.push(token);
    } else {
      parsed[key] = value;
    }
  }
  return parsed;
}

// 'YYYY', 'YYYY-MM' or 'YYYY-MM-DD' → { start, end } in local time, end exclusive.
export function monthRange(value) {
  const m = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(value);
  if (!m) return null;
  const y = Number(m[1]);
  if (m[3]) {
    const start = new Date(y, Number(m[2]) - 1, Number(m[3]));
    return { start: start.getTime(), end: new Date(y, Number(m[2]) - 1, Number(m[3]) + 1).getTime() };
  }
  if (m[2]) return { start: new Date(y, Number(m[2]) - 1, 1).getTime(), end: new Date(y, Number(m[2]), 1).getTime() };
  return { start: new Date(y, 0, 1).getTime(), end: new Date(y + 1, 0, 1).getTime() };
}

export function hasTerms(parsed) {
  return parsed.words.length > 0 || FILTERS.some((k) => parsed[k] != null);
}

// The filter tokens alone (everything but the plain words).
export function passesFilters(item, parsed) {
  if (parsed.site && !String(item.site || '').toLowerCase().includes(parsed.site)) return false;
  if (parsed.intent && String(item.intent || '').toLowerCase() !== parsed.intent) return false;
  if (parsed.before != null || parsed.after != null) {
    const when = item.ended_at || item.saved_at;
    if (!when) return false;
    if (parsed.before != null && when >= parsed.before) return false;
    if (parsed.after != null && when < parsed.after) return false;
  }
  return true;
}

// Lowercased text per item, cached until the item object is replaced.
const cache = new WeakMap();
export function haystack(item) {
  let h = cache.get(item);
  if (!h) {
    const low = (s) => String(s || '').toLowerCase();
    h = { title: low(item.title), site: low(item.site), takeaway: low(item.takeaway), note: low(item.note) };
    cache.set(item, h);
  }
  return h;
}

// The Vault's predicate: filters, then every word as a plain substring.
export function matches(item, parsed) {
  if (!passesFilters(item, parsed)) return false;
  if (!parsed.words.length) return true;
  const h = haystack(item);
  return parsed.words.every((w) => h.title.includes(w) || h.site.includes(w) || h.takeaway.includes(w) || h.note.includes(w));
}

// Fuzzy score of one lowercased word in one lowercased text; 0 = no match.
// A substring scores highest (more at a word start); otherwise the letters in
// order, with bonuses for runs and word starts.
export function fuzzyScore(word, text) {
  if (!word || !text) return 0;
  const at = text.indexOf(word);
  if (at >= 0) return 100 + (isStart(text, at) ? 40 : 0) + word.length * 2 - Math.min(at, 40) / 4;
  let score = 0;
  let from = 0;
  let run = 0;
  for (const ch of word) {
    const j = text.indexOf(ch, from);
    if (j < 0) return 0;
    run = j === from && from > 0 ? run + 1 : 0;
    score += 1 + run * 3 + (isStart(text, j) ? 4 : 0) - (from > 0 ? Math.min(j - from, 10) / 2 : 0);
    from = j + 1;
  }
  // Letters scattered across a long string are noise, not a match.
  return score >= word.length * 2 ? score : 0;
}

function isStart(text, i) {
  return i === 0 || !/[a-z0-9]/.test(text[i - 1]);
}

// The palette's score for an item: filters must pass, each word must hit
// some field. Takeaways and notes only match as substrings (a long text
// contains any short subsequence); titles and sites may match fuzzily.
export function scoreItem(item, parsed) {
  if (!passesFilters(item, parsed)) return 0;
  if (!parsed.words.length) return 1;
  const h = haystack(item);
  let total = 0;
  for (const w of parsed.words) {
    const best = Math.max(
      fuzzyScore(w, h.title) * 1.2,
      fuzzyScore(w, h.site),
      h.takeaway.includes(w) ? fuzzyScore(w, h.takeaway) : 0,
      h.note.includes(w) ? fuzzyScore(w, h.note) * 0.9 : 0
    );
    if (!best) return 0;
    total += best;
  }
  return total;
}

// Score a command label against the whole query (no filters for commands).
export function scoreLabel(label, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const text = label.toLowerCase();
  let total = 0;
  for (const w of words) {
    const s = fuzzyScore(w, text);
    if (!s) return 0;
    total += s;
  }
  return total;
}
