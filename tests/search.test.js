// The Vault and palette search: query parsing, filters and the fuzzy scorer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyScore, matches, monthRange, parseQuery, scoreItem, scoreLabel } from '../public/search.js';

const at = (y, m, d = 15) => new Date(y, m - 1, d).getTime();
const vault = [
  { id: 1, title: 'The Slow Web', site: 'nytimes.com', intent: 'weekend', ended_at: at(2026, 8), takeaway: 'Attention is rent.' },
  { id: 2, title: 'Compost heaps', site: 'gardening.org', intent: null, ended_at: at(2026, 9), takeaway: null },
  { id: 3, title: 'Rust ownership', site: 'blog.rust-lang.org', intent: 'tonight', ended_at: at(2026, 10), takeaway: 'Borrow, then return.', note: 'reread the lifetimes part' },
];
const ids = (q) => vault.filter((i) => matches(i, parseQuery(q))).map((i) => i.id);

test('parseQuery splits filters from plain words', () => {
  const p = parseQuery('  Site:NYTimes.com intent:weekend slow  WEB ');
  assert.equal(p.site, 'nytimes.com');
  assert.equal(p.intent, 'weekend');
  assert.deepEqual(p.words, ['slow', 'web']);
  assert.equal(p.before, null);
});

test('before and after take whole months, both exclusive', () => {
  const p = parseQuery('before:2026-09 after:2026-03');
  assert.equal(p.before, new Date(2026, 8, 1).getTime());
  assert.equal(p.after, new Date(2026, 3, 1).getTime());
  assert.deepEqual(monthRange('2026'), { start: new Date(2026, 0, 1).getTime(), end: new Date(2027, 0, 1).getTime() });
  assert.equal(monthRange('2026-10-05').start, new Date(2026, 9, 5).getTime());
  assert.equal(monthRange('Sept'), null);
});

test('malformed or unknown tokens stay plain words', () => {
  assert.deepEqual(parseQuery('before:soon foo:bar site:').words, ['before:soon', 'foo:bar', 'site:']);
});

test('matches applies every token', () => {
  assert.deepEqual(ids(''), [1, 2, 3]);
  assert.deepEqual(ids('site:nytimes'), [1]);
  assert.deepEqual(ids('site:rust-lang.org'), [3]);
  assert.deepEqual(ids('intent:tonight'), [3]);
  assert.deepEqual(ids('before:2026-09'), [1]);
  assert.deepEqual(ids('after:2026-08'), [2, 3]);
  assert.deepEqual(ids('after:2026-08 before:2026-10'), [2]);
  assert.deepEqual(ids('attention'), [1]); // takeaway
  assert.deepEqual(ids('lifetimes'), [3]); // note
  assert.deepEqual(ids('compost'), [2]);   // title
  assert.deepEqual(ids('gardening'), [2]); // site
  assert.deepEqual(ids('borrow intent:weekend'), []);
  assert.deepEqual(ids('slow rent'), [1]);
});

test('rack items without ended_at use saved_at for dates', () => {
  const item = { title: 'x', site: 'y', saved_at: at(2026, 5), ended_at: null };
  assert.equal(matches(item, parseQuery('before:2026-06')), true);
  assert.equal(matches(item, parseQuery('after:2026-05')), false);
});

test('fuzzyScore prefers substrings and word starts', () => {
  assert.equal(fuzzyScore('xyz', 'compost'), 0);
  assert.ok(fuzzyScore('cmp', 'compost') > 0);
  assert.ok(fuzzyScore('com', 'compost') > fuzzyScore('cmp', 'compost'));
  assert.ok(fuzzyScore('web', 'the web') > fuzzyScore('web', 'cobweb'));
  // Letters scattered across long text don't count.
  assert.equal(fuzzyScore('ae', 'a long sentence that ends with e'), 0);
});

test('scoreItem matches takeaways only as substrings, titles fuzzily', () => {
  const [slow, , rust] = vault;
  assert.ok(scoreItem(slow, parseQuery('rent')) > 0);
  assert.equal(scoreItem(slow, parseQuery('rnt')), 0);
  assert.ok(scoreItem(rust, parseQuery('rstown')) > 0);
  assert.equal(scoreItem(rust, parseQuery('site:nytimes rust')), 0);
});

test('scoreLabel needs every word', () => {
  assert.ok(scoreLabel('Export vault as Markdown', 'exp md') > 0);
  assert.equal(scoreLabel('Export vault as Markdown', 'exp json'), 0);
});
