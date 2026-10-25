// Shows the bookmarklet with this app's own address already filled in.
import { S } from './strings.js';
import { el } from './api.js';

const code =
  `javascript:(()=>{window.open('${location.origin}/save?url='+encodeURIComponent(location.href),` +
  `'compost','width=440,height=620')})()`;

const link = el('a', { className: 'button bookmarklet', href: code }, S.bookmarkletName);
link.addEventListener('click', (e) => e.preventDefault());

const field = el('textarea', { readOnly: true, rows: 4, value: code, 'aria-label': S.bookmarkletCopy });
field.addEventListener('focus', () => field.select());

document.getElementById('app').replaceChildren(
  el('h1', {}, S.bookmarkletTitle),
  el('p', {}, S.bookmarkletDrag),
  el('p', {}, link),
  el('p', { className: 'meta' }, S.bookmarkletUse),
  el('p', { className: 'meta' }, S.bookmarkletCopy),
  field,
  el('p', { className: 'footer' }, el('a', { href: '/' }, S.back))
);
