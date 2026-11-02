// The options page: Compost address and passcode, kept in chrome.storage.local.
// Saving asks Chrome for permission to reach that address, so the extension's
// own requests don't depend on the server's CORS headers.
import { S } from './strings.js';
import { api, el, getSettings, normaliseAddress, originPattern, setSettings, NoPermission, Unauthorized } from './common.js';

const root = document.getElementById('app');

async function start() {
  const current = await getSettings();
  const address = el('input', { id: 'address', type: 'url', value: current.address, placeholder: 'https://', autocomplete: 'off', spellcheck: false });
  const passcode = el('input', { id: 'passcode', type: 'password', value: current.passcode, autocomplete: 'current-password' });
  const saveBtn = el('button', { type: 'submit' }, S.save);
  const testBtn = el('button', { type: 'button' }, S.testConnection);
  const status = el('p', { className: 'status', role: 'status' });

  const form = el(
    'form',
    {},
    el('label', { htmlFor: 'address' }, S.addressLabel),
    address,
    el('p', { className: 'hint' }, S.addressHint),
    el('label', { htmlFor: 'passcode' }, S.passcodeLabel),
    passcode,
    el('div', { className: 'actions' }, saveBtn, testBtn),
    status
  );

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const origin = normaliseAddress(address.value);
    if (!origin) return (status.textContent = S.invalidAddress);
    // permissions.request must run inside the click, before any await.
    const granted = chrome.permissions.request({ origins: [originPattern(origin)] });
    saveAndTest(origin, granted);
  });
  testBtn.addEventListener('click', () => {
    const origin = normaliseAddress(address.value);
    if (!origin) return (status.textContent = S.invalidAddress);
    saveAndTest(origin, Promise.resolve(true));
  });

  async function saveAndTest(origin, granted) {
    address.value = origin;
    await setSettings({ address: origin, passcode: passcode.value });
    saveBtn.disabled = testBtn.disabled = true;
    status.textContent = S.testing;
    try {
      if (!(await granted)) throw new NoPermission();
      await api('/api/items');
      status.textContent = S.connected;
    } catch (err) {
      if (err instanceof Unauthorized) status.textContent = S.passcodeWrong;
      else if (err instanceof NoPermission) status.textContent = S.permissionDenied;
      else status.textContent = S.offline;
    } finally {
      saveBtn.disabled = testBtn.disabled = false;
    }
  }

  root.replaceChildren(el('h1', {}, S.optionsTitle), form, el('p', { className: 'hint' }, S.shortcutNote));
  (current.address ? passcode : address).focus();
}

start();
