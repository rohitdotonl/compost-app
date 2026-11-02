// Shared by the popup, the options page and the service worker: settings in
// chrome.storage.local, the API call, the host permission and the el() helper.

const SETTINGS_KEY = 'settings';

export async function getSettings() {
  const { [SETTINGS_KEY]: s } = await chrome.storage.local.get(SETTINGS_KEY);
  return { address: '', passcode: '', ...(s || {}) };
}

export async function setSettings(next) {
  const current = await getSettings();
  await chrome.storage.local.set({ [SETTINGS_KEY]: { ...current, ...next } });
}

// Turns what the user typed into an origin like
// https://compost.example.workers.dev, or null if it isn't one.
export function normaliseAddress(value) {
  let text = String(value || '').trim();
  if (!text) return null;
  if (!/^https?:\/\//i.test(text)) text = (/^(localhost|127\.0\.0\.1)(:|\/|$)/i.test(text) ? 'http://' : 'https://') + text;
  try {
    const url = new URL(text);
    if (!/^https?:$/.test(url.protocol)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

// The match pattern the host permission for an origin needs.
export function originPattern(origin) {
  return origin + '/*';
}

export function hasHostPermission(origin) {
  return chrome.permissions.contains({ origins: [originPattern(origin)] });
}

export class NotSetUp extends Error {}
export class Unauthorized extends Error {}
export class NoPermission extends Error {}

// Calls the Compost API. Resolves to { status, data }. Throws NotSetUp when
// no address is stored, Unauthorized on 401, NoPermission when the browser
// blocked the request for lack of a host permission, and a plain Error when
// the network or server fails.
export async function api(path, body) {
  const { address, passcode } = await getSettings();
  if (!address) throw new NotSetUp();
  let res;
  try {
    res = await fetch(address + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Passcode': passcode },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    if (!(await hasHostPermission(address))) throw new NoPermission();
    throw err;
  }
  if (res.status === 401) throw new Unauthorized();
  const data = await res.json().catch(() => ({}));
  if (res.status >= 500) throw new Error(data.error || 'server_error');
  return { status: res.status, data };
}

// Only http(s) pages can be saved; chrome://, file:// and the like can't.
export function isSavable(url) {
  return /^https?:\/\//i.test(url || '');
}

export function siteOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export function weekdayOf(ms) {
  return new Date(ms).toLocaleDateString(undefined, { weekday: 'long' });
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
