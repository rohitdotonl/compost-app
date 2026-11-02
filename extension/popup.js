// The toolbar popup. Saves the page as soon as it opens and shows the plain
// receipt, exactly like the Save page. Opened with ?url=&title= it saves that
// link instead of the current tab (the context menu uses this when the rack
// is full and someone has to pick what to drop).
import { S } from './strings.js';
import { api, el, isSavable, siteOf, weekdayOf, NotSetUp, NoPermission, Unauthorized } from './common.js';

const root = document.getElementById('app');
const params = new URLSearchParams(location.search);
let page = { url: '', title: '', tabId: null };

async function start() {
  if (params.get('url')) {
    page = { url: params.get('url'), title: params.get('title') || '', tabId: null };
  } else {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    page = { url: tab?.url || '', title: tab?.title || '', tabId: tab?.id ?? null };
  }
  if (!isSavable(page.url)) return show(el('p', { className: 'receipt quiet' }, S.notAPage));
  await save();
}

async function save(dropId, note) {
  show(pageLine(), el('p', { className: 'receipt quiet' }, S.saving));
  let res;
  try {
    res = await api('/api/items', {
      url: page.url,
      title: page.title,
      ...(dropId != null && { dropId }),
      ...(note && { note }),
    });
  } catch (err) {
    return showError(err, () => save(dropId, note));
  }

  const { data } = res;
  switch (data.status) {
    case 'saved': tellBackground('in_rack'); return showReceipt(data, note);
    case 'in_rack': tellBackground('in_rack'); return show(pageLine(), el('p', { className: 'receipt' }, S.alreadyInRack), rackLink());
    case 'in_vault': tellBackground('in_vault'); return show(pageLine(), el('p', { className: 'receipt' }, S.alreadyInVault), rackLink());
    case 'full': return showFull(data.rack, note);
    case 'invalid_url': return show(pageLine(), el('p', { className: 'receipt quiet' }, S.invalidLink));
    default: return show(pageLine(), el('p', { className: 'receipt' }, S.somethingWrong));
  }
}

function showReceipt({ item, used, limit }, note) {
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
    pageLine(item),
    el('p', { className: 'receipt' }, S.savedReceipt(used, limit, weekdayOf(item.expires_at))),
    el('p', { className: 'meta' }, S.intentQuestion),
    chips,
    note ? null : noteField(item),
    rackLink()
  );
}

// The optional one-line "why". It goes to the server as `note` in the save
// body: a second POST of the same URL, which today answers in_rack and is
// otherwise harmless.
function noteField(item) {
  const input = el('input', { type: 'text', maxLength: 140, placeholder: S.notePlaceholder, 'aria-label': S.notePlaceholder });
  const form = el('form', { className: 'note' }, input);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const note = input.value.trim();
    if (!note) return;
    input.disabled = true;
    try {
      await api('/api/items', { url: item.url || page.url, title: page.title, note });
      form.replaceChildren(el('p', { className: 'meta' }, S.noteSaved));
    } catch {
      input.disabled = false;
    }
  });
  return form;
}

function showFull(rack, note) {
  const list = el('ul', { className: 'choices' });
  const dropBtn = el('button', { type: 'submit', disabled: true }, S.dropAndSave);
  for (const item of rack) {
    const radio = el('input', { type: 'radio', name: 'drop', value: String(item.id) });
    radio.addEventListener('change', () => (dropBtn.disabled = false));
    list.append(
      el('li', {}, el('label', {}, radio, el('span', {}, item.title, el('span', { className: 'site' }, item.site))))
    );
  }
  const noteInput = el('input', { type: 'text', maxLength: 140, value: note || '', placeholder: S.notePlaceholder, 'aria-label': S.notePlaceholder });
  const cancel = el('button', { type: 'button' }, S.cancel);
  cancel.addEventListener('click', () => show(pageLine(), el('p', { className: 'receipt quiet' }, S.nothingSaved)));
  const form = el(
    'form',
    {},
    el('p', { className: 'receipt' }, S.rackFull),
    list,
    el('div', { className: 'note' }, noteInput),
    el('div', { className: 'actions' }, dropBtn, cancel)
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const picked = form.querySelector('input[name="drop"]:checked');
    if (picked) save(Number(picked.value), noteInput.value.trim());
  });
  show(pageLine(), form);
}

function showError(err, retry) {
  if (err instanceof NotSetUp) return show(el('p', { className: 'receipt' }, S.notSetUp), optionsLink());
  if (err instanceof Unauthorized) return show(el('p', { className: 'receipt' }, S.passcodeWrong), optionsLink());
  if (err instanceof NoPermission) return show(el('p', { className: 'receipt' }, S.noPermission), optionsLink());
  const button = el('button', { type: 'button' }, S.retry);
  button.addEventListener('click', retry);
  show(pageLine(), el('p', { className: 'receipt' }, S.offline), el('div', { className: 'actions' }, button));
}

// Title and site of the page, from the server's answer when there is one.
function pageLine(item) {
  const title = item?.title || page.title || page.url;
  return el('p', { className: 'page' }, el('span', { className: 'title' }, title), el('span', { className: 'site' }, item?.site || siteOf(page.url)));
}

function optionsLink() {
  const link = el('a', { href: '#' }, S.openOptions);
  link.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
  return el('p', { className: 'footer' }, link);
}

function rackLink() {
  const link = el('a', { href: '#' }, S.openRack);
  link.addEventListener('click', async (e) => {
    e.preventDefault();
    const { settings } = await chrome.storage.local.get('settings');
    if (settings?.address) chrome.tabs.create({ url: settings.address + '/' });
  });
  return el('p', { className: 'footer' }, link);
}

// Lets the service worker update the toolbar mark without another lookup.
function tellBackground(status) {
  chrome.runtime.sendMessage({ type: 'saved', url: page.url, status, tabId: page.tabId }).catch(() => {});
}

function show(...nodes) {
  root.replaceChildren(el('h1', {}, S.appName), ...nodes);
}

start();
