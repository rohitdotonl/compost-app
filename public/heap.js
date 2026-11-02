// The Heap tab: what was tossed, dropped or expired. No restore, on purpose.
import { S } from './strings.js';
import { el } from './api.js';
import { cover, displayTitle, shortDate } from './format.js';

export function createHeapPanel() {
  const list = el('ul', { className: 'list heap' });
  const element = el('section', { className: 'panel' }, el('p', { className: 'note' }, S.heapNote), list);

  function render(state) {
    const heap = state.data.heap;
    if (!heap.length) {
      list.replaceChildren(el('li', { className: 'calm' }, S.heapEmpty));
      return;
    }
    list.replaceChildren(
      ...heap.map((item) =>
        el(
          'li',
          { className: 'item', dataset: { id: String(item.id) } },
          cover(item, { size: 'sm' }),
          el(
            'div',
            { className: 'heap-body' },
            el('p', { className: 'title' }, displayTitle(item)),
            el('a', { className: 'url', href: item.url, target: '_blank', rel: 'noopener noreferrer' }, item.url),
            el('p', { className: 'meta' }, S.leftOn(shortDate(item.ended_at)))
          )
        )
      )
    );
  }

  return { element, render };
}
