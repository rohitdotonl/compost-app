// Talks to the Worker. Shared by the main page and the Save page.
const KEY = 'compost.passcode';

export function getPasscode() {
  try { return localStorage.getItem(KEY) || ''; } catch { return ''; }
}

export function setPasscode(value) {
  try { localStorage.setItem(KEY, value); } catch {}
}

export function clearPasscode() {
  try { localStorage.removeItem(KEY); } catch {}
}

export class Unauthorized extends Error {}

// Resolves to { status, data }. Throws Unauthorized on 401 and a plain
// Error when the network or server fails.
export async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Passcode': getPasscode() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    clearPasscode();
    throw new Unauthorized();
  }
  const data = await res.json().catch(() => ({}));
  if (res.status >= 500) throw new Error(data.error || 'server_error');
  return { status: res.status, data };
}

// Renders a passcode form into `root` and resolves once a passcode that the
// server accepts has been stored.
export function askPasscode(root, S, wrong = false) {
  return new Promise((resolve) => {
    root.replaceChildren();
    const form = el('form', { className: 'passcode' });
    const p = el('p', {}, wrong ? S.passcodeWrong : S.passcodePrompt);
    const label = el('label', { htmlFor: 'passcode' }, S.passcodeLabel);
    const input = el('input', { id: 'passcode', type: 'password', autocomplete: 'current-password', required: true });
    const button = el('button', { type: 'submit' }, S.passcodeSubmit);
    form.append(el('img', { className: 'passcode-icon', src: '/icons/icon.svg', alt: '' }), el('h1', {}, S.appName), p, label, el('div', { className: 'row' }, input, button));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      setPasscode(input.value);
      button.disabled = true;
      try {
        await api('/api/items');
        resolve();
      } catch (err) {
        button.disabled = false;
        p.textContent = err instanceof Unauthorized ? S.passcodeWrong : S.offline;
        input.select();
      }
    });
    root.append(form);
    input.focus();
  });
}

// Tiny element helper: el('a', { href }, 'text', child, ...)
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null && c !== false) node.append(c);
  return node;
}
