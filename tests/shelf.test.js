// The bookshelf's pure helpers: month shelves, spine widths and site tints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TINTS, groupByMonth, siteHue, spineHeight, spineWidth, wear } from '../public/shelf.js';

const at = (y, m, d = 15, h = 12) => new Date(y, m - 1, d, h).getTime();

test('groupByMonth puts the newest shelf first and the newest item first', () => {
  const items = [
    { id: 1, ended_at: at(2026, 8, 3) },
    { id: 2, ended_at: at(2026, 10, 1) },
    { id: 3, ended_at: at(2026, 10, 20) },
    { id: 4, ended_at: at(2025, 12, 31) },
    { id: 5, ended_at: at(2026, 8, 30) },
  ];
  const shelves = groupByMonth(items);
  assert.deepEqual(shelves.map((s) => s.key), ['2026-10', '2026-08', '2025-12']);
  assert.deepEqual(shelves.map((s) => s.items.map((i) => i.id)), [[3, 2], [5, 1], [4]]);
  assert.equal(shelves[0].year, 2026);
  assert.equal(shelves[0].month, 9);
});

test('groupByMonth uses local month edges and handles nothing', () => {
  assert.deepEqual(groupByMonth([]), []);
  const edge = groupByMonth([{ id: 1, ended_at: new Date(2026, 8, 30, 23, 59).getTime() }, { id: 2, ended_at: new Date(2026, 9, 1, 0, 1).getTime() }]);
  assert.deepEqual(edge.map((s) => s.key), ['2026-10', '2026-09']);
});

test('spineWidth grows with minutes inside its bounds', () => {
  assert.equal(spineWidth(null), 24);
  assert.equal(spineWidth(undefined), 24);
  assert.equal(spineWidth(0), 24);
  assert.equal(spineWidth(1), 21);
  assert.equal(spineWidth(5), 33);
  assert.equal(spineWidth(10), 48);
  assert.equal(spineWidth(60), 64);
  assert.ok(spineWidth(4) < spineWidth(8));
});

test('siteHue is stable, bounded and ignores www. and case', () => {
  const sites = ['nytimes.com', 'blog.rust-lang.org', 'example.com', 'a.b', 'gardening.org', 'theatlantic.com'];
  for (const site of sites) {
    const hue = siteHue(site);
    assert.ok(Number.isInteger(hue) && hue >= 0 && hue < TINTS);
    assert.equal(siteHue(site), hue);
  }
  assert.equal(siteHue('WWW.NYTimes.com'), siteHue('nytimes.com'));
  assert.equal(siteHue(''), siteHue(null));
  // Spread: a handful of sites shouldn't all share one tint.
  assert.ok(new Set(sites.map(siteHue)).size > 2);
});

test('spine heights vary a little; wear steps with highlights', () => {
  const h = spineHeight({ id: 7, title: 'x' });
  assert.ok(h >= 0.86 && h <= 1);
  assert.equal(spineHeight({ id: 7, title: 'x' }), h);
  assert.deepEqual([undefined, 0, 1, 2, 3, 5, 6, 40].map(wear), [0, 0, 1, 1, 2, 2, 3, 3]);
});
