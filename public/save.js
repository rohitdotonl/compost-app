// The Save page. Opened by the Android share menu (/save?url=…&text=…&title=…)
// and by the bookmarklet (/save?url=…).
import { S } from './strings.js';
import { api, askPasscode, el, getPasscode, Unauthorized } from './api.js';
import { thumbnail, untilDay, urlPath } from './format.js';

const root = document.getElementById('app');
const params = new URLSearchParams(location.search);
const url = findUrl();

// Android often puts the link in `text` rather than `url`, so take the first
// URL found in url, text or title.
function findUrl() {
  for (const key of ['url', 'text', 'title']) {
    const match = (params.get(key) || '').match(/https?:\/\/[^\s<>"]+/i);
    if (match) return match[0];
  }
  return null;
}

// A title hint from the share sheet, used only if the page can't be fetched.
function titleHint() {
  const title = params.get('title') || '';
  return /https?:\/\//i.test(title) ? '' : title;
}

async function start() {
  if (!url) return show(el('p', { className: 'receipt' }, S.noLink), closeLink());
  if (!getPasscode()) await askPasscode(root, S);
  await save();
}

async function save(dropId) {
  show(el('p', { className: 'receipt' }, S.saving));
  let res;
  try {
    res = await api('/api/items', { url, title: titleHint(), ...(dropId != null && { dropId }) });
  } catch (err) {
    if (err instanceof Unauthorized) {
      await askPasscode(root, S, true);
      return save(dropId);
    }
    const retry = el('button', { type: 'button', onclick: () => save(dropId) }, S.retry);
    return show(el('p', { className: 'receipt' }, S.offline), el('div', { className: 'actions' }, retry, closeLink()));
  }

  const { data } = res;
  // Once the save has been answered, drop the link from the address so a
  // reload or a resumed share window doesn't save it again.
  if (data.status !== 'full') history.replaceState(null, '', '/save');
  switch (data.status) {
    case 'saved': return showReceipt(data);
    case 'in_rack': return show(el('p', { className: 'receipt' }, S.alreadyInRack), closeLink());
    case 'in_vault': return show(el('p', { className: 'receipt' }, S.alreadyInVault), closeLink());
    case 'full': return showFull(data.rack);
    case 'invalid_url': return show(el('p', { className: 'receipt' }, S.invalidLink), closeLink());
    default: return show(el('p', { className: 'receipt' }, S.somethingWrong), closeLink());
  }
}

function showReceipt({ item, used, limit }) {
  const chips = el('div', { className: 'chips', role: 'group', 'aria-label': S.intentQuestion });
  for (const [value, label] of Object.entries(S.intents)) {
    const chip = el('button', { type: 'button', 'aria-pressed': 'false' }, label);
    chip.addEventListener('click', async () => {
      const intent = chip.getAttribute('aria-pressed') === 'true' ? null : value;
      try {
        await api(`/api/items/${item.id}/intent`, { intent });
        for (const c of chips.children) c.setAttribute('aria-pressed', String(c === chip && intent !== null));
      } catch {
        // Leave the chips as they were; the save itself already worked.
      }
    });
    chips.append(chip);
  }
  show(
    el(
      'div',
      { className: 'receipt saved' },
      el('div', { className: 'cover-wrap' }, thumbnail(item)),
      el('div', { className: 'receipt-text' },
        el('p', { className: 'title' }, item.title === item.url ? urlPath(item.url) : item.title),
        el('p', { className: 'meta' }, S.slotReceipt(used, limit, untilDay(item.expires_at))))
    ),
    el('div', { className: 'intent' }, el('p', { className: 'meta' }, S.intentQuestion), chips),
    closeLink()
  );
}

function showFull(rack) {
  const list = el('ul', { className: 'choices' });
  const dropBtn = el('button', { type: 'submit', disabled: true }, S.dropAndSave);
  for (const item of rack) {
    const radio = el('input', { type: 'radio', name: 'drop', value: String(item.id) });
    radio.addEventListener('change', () => (dropBtn.disabled = false));
    list.append(
      el('li', {}, el('label', {}, radio, el('span', { className: 'choice-text' }, el('span', { className: 'choice-title' }, item.title), el('span', { className: 'site' }, item.site))))
    );
  }
  const cancel = el('button', { type: 'button', onclick: close }, S.cancel);
  const form = el('form', { className: 'full' }, el('p', { className: 'receipt' }, S.rackFull), list, el('div', { className: 'actions' }, dropBtn, cancel));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const picked = form.querySelector('input[name="drop"]:checked');
    if (picked) save(Number(picked.value));
  });
  show(form);
}

function closeLink() {
  const link = el('a', { href: '/', className: 'button' }, S.close);
  link.addEventListener('click', (e) => {
    e.preventDefault();
    close();
  });
  return el('p', { className: 'actions' }, link);
}

// Closes the popup or share window. If the browser won't let a script close
// it, go to the Rack instead.
function close() {
  window.close();
  setTimeout(() => location.replace('/'), 200);
}

function show(...nodes) {
  root.replaceChildren(
    el('header', { className: 'page-brand' }, el('img', { src: '/icons/icon.svg', alt: '', width: 28, height: 28 }), el('h1', {}, S.appName)),
    el('div', { className: 'page-card' }, ...nodes)
  );
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
start();
