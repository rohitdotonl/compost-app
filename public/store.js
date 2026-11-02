// State for the main page: the last list from the server, a localStorage copy
// of it for instant opens, and the actions. Actions are optimistic: the state
// changes at once, the request goes out, and a failure rolls back with a calm
// line in the status.
//
// Views subscribe() and re-render from getState(). Keyboard shortcuts (Phase
// 2, keys.js) drive the same exported functions: select / moveSelection for
// the row under focus and done / toss / extend / setIntent / open on it.
import { S } from './strings.js';
import { api, Unauthorized } from './api.js';

const CACHE_KEY = 'compost.items';
const STATUS_MS = 5000;

const state = {
  data: null,        // { now, rules, rack, vault, heap } as GET /api/items returns it
  selectedId: null,  // row the keyboard is on, in whichever tab is showing
  promptId: null,    // rack row showing the takeaway prompt
  status: null,      // { text, action: { label, run } | null }
};
const listeners = new Set();
let onUnauthorized = () => {};
let statusTimer = null;

export function getState() {
  return state;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) fn(state);
}

// Called when the server rejects the passcode; app.js asks for it again.
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

// ---------------------------------------------------------------------------
// Loading and the cache
// ---------------------------------------------------------------------------

// Paints the last response straight away. Returns true if there was one.
export function paintFromCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return false;
    state.data = JSON.parse(raw);
    emit();
    return true;
  } catch {
    return false;
  }
}

function remember() {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(state.data)); } catch {}
}

export function forgetCache() {
  try { localStorage.removeItem(CACHE_KEY); } catch {}
}

// Fetches the full list. Throws Unauthorized or a plain Error; the caller
// decides what to show.
export async function load() {
  const { data } = await api('/api/items');
  state.data = data;
  remember();
  emit();
}

// ---------------------------------------------------------------------------
// Reading the state
// ---------------------------------------------------------------------------

export function rules() {
  return state.data ? state.data.rules : { slots: 10, lifespan: 7 * 864e5, extension: 1728e5 };
}

// Rack rows worth showing: a cached copy may still hold something that has
// expired since, which the server's sweep would have moved to the Heap.
export function rackItems(now = Date.now()) {
  return state.data ? state.data.rack.filter((i) => i.expires_at > now) : [];
}

export function used() {
  return rackItems().length;
}

export function rackItem(id) {
  return state.data ? state.data.rack.find((i) => i.id === id) : null;
}

// Any item by id, with the tab it lives on: { item, tab } or null.
export function locate(id) {
  if (!state.data) return null;
  for (const tab of ['rack', 'vault', 'heap']) {
    const item = state.data[tab].find((i) => i.id === id);
    if (item) return { item, tab };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

export function setStatus(text, action = null, ms = STATUS_MS) {
  state.status = text ? { text, action } : null;
  clearTimeout(statusTimer);
  if (text) statusTimer = setTimeout(() => setStatus(null), ms);
  emit();
}

// ---------------------------------------------------------------------------
// Selection and the takeaway prompt (the keyboard hooks)
// ---------------------------------------------------------------------------

export function select(id) {
  state.selectedId = id;
  emit();
}

// `ids` is the order on screen; keys.js passes the visible tab's rows.
export function moveSelection(delta, ids = rackItems().map((i) => i.id)) {
  if (!ids.length) return;
  const index = ids.indexOf(state.selectedId);
  const next = index < 0 ? (delta > 0 ? 0 : ids.length - 1) : Math.min(ids.length - 1, Math.max(0, index + delta));
  select(ids[next]);
}

export function beginDone(id) {
  state.promptId = id;
  emit();
}

export function cancelDone() {
  state.promptId = null;
  emit();
}

export function open(id) {
  if (reader && reader(id)) return;
  const item = locate(id)?.item;
  if (item) window.open(item.url, '_blank', 'noopener');
}

// Phase 4: reader.js registers here. It returns true when it took the open
// (the reader, or the original after a failed extraction).
let reader = null;
export function setReader(fn) {
  reader = fn;
}

// Phase 4: updates fields of a rack or Vault item from outside an action
// (the reader's real reading time, progress). No request is sent.
export function patchItem(id, fields) {
  if (!state.data) return;
  for (const key of ['rack', 'vault']) {
    const item = state.data[key].find((i) => i.id === id);
    if (item) Object.assign(item, fields);
  }
  remember();
  emit();
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export function done(id, takeaway) {
  const item = rackItem(id);
  if (!item) return;
  state.promptId = null;
  setStatus(S.slotFreed(used() - 1, rules().slots));
  return optimistic(
    () => place({ ...item, outcome: 'done', ended_at: Date.now(), takeaway: takeaway || null }),
    () => api(`/api/items/${id}/done`, takeaway ? { takeaway } : {})
  );
}

export function toss(id) {
  const item = rackItem(id);
  if (!item) return;
  setStatus(S.tossed, { label: S.undo, run: () => untoss(id) });
  return optimistic(
    () => place({ ...item, outcome: 'tossed', ended_at: Date.now() }),
    () => api(`/api/items/${id}/toss`, {})
  );
}

// The Undo behind a toss, within the server's window. Not a Heap restore.
export function untoss(id) {
  const item = state.data && state.data.heap.find((i) => i.id === id);
  if (!item) return;
  setStatus(S.restored);
  return optimistic(
    () => place({ ...item, outcome: null, ended_at: null }),
    () => api(`/api/items/${id}/untoss`, {}),
    (status) => (status === 409 ? S.undoExpired : null)
  );
}

export function extend(id) {
  const item = rackItem(id);
  if (!item || item.extended) return;
  return optimistic(
    () => place({ ...item, expires_at: item.expires_at + rules().extension, extended: 1 }),
    () => api(`/api/items/${id}/extend`, {})
  );
}

export function setIntent(id, intent) {
  const item = rackItem(id);
  if (!item) return;
  return optimistic(
    () => place({ ...item, intent }),
    () => api(`/api/items/${id}/intent`, { intent })
  );
}

// Rewrites a Vault item's takeaway (Phase 6).
export function editTakeaway(id, takeaway) {
  const item = state.data && state.data.vault.find((i) => i.id === id);
  if (!item) return;
  return optimistic(
    () => place({ ...item, takeaway: takeaway || null }),
    () => api(`/api/items/${id}/takeaway`, { takeaway })
  );
}

// Fetches the page again for a row that came in bare. Waits for the server,
// like a save; resolves to the updated item or null.
export async function refreshDetails(id) {
  try {
    const { status, data } = await api(`/api/items/${id}/refresh`, {});
    if (status >= 400 || !data.item) throw new Rejected(status, data);
    place(data.item);
    remember();
    emit();
    return data.item;
  } catch (err) {
    if (err instanceof Unauthorized) onUnauthorized();
    else setStatus(S.actionFailed);
    return null;
  }
}

// Saving waits for the server (it fetches the title). Resolves to the
// response data, or null when the request failed.
export async function add(url) {
  try {
    const { data } = await api('/api/items', { url });
    if (data.status === 'saved') {
      place(data.item);
      remember();
      emit();
    }
    return data;
  } catch (err) {
    if (err instanceof Unauthorized) onUnauthorized();
    else setStatus(S.offline);
    return null;
  }
}

// Applies a change, sends the request, and puts the server's version of the
// item in place. A failed request restores the state as it was.
async function optimistic(apply, request, failText = () => null) {
  const snapshot = JSON.parse(JSON.stringify(state.data));
  apply();
  emit();
  try {
    const { status, data } = await request();
    if (status >= 400) throw new Rejected(status, data);
    if (data.item) place(data.item);
    remember();
    emit();
    return data;
  } catch (err) {
    state.data = snapshot;
    if (err instanceof Unauthorized) {
      emit();
      onUnauthorized();
      return null;
    }
    const rejected = err instanceof Rejected;
    setStatus((rejected && failText(err.status)) || S.actionFailed);
    // A rejection means the server knows better than our copy: refresh.
    if (rejected) load().catch(() => {});
    return null;
  }
}

class Rejected extends Error {
  constructor(status, data) {
    super((data && data.error) || String(status));
    this.status = status;
  }
}

// Puts an item in the list its outcome says, replacing any older copy,
// keeping each list in the server's order.
function place(item) {
  const d = state.data;
  // Action answers carry no highlight count (Phase 5); keep the one we had.
  const old = item.highlights == null && locate(item.id);
  if (old && old.item.highlights != null) item = { ...item, highlights: old.item.highlights };
  for (const key of ['rack', 'vault', 'heap']) d[key] = d[key].filter((i) => i.id !== item.id);
  if (item.outcome == null) {
    d.rack.push(item);
    d.rack.sort((a, b) => a.expires_at - b.expires_at || a.id - b.id);
  } else if (item.outcome === 'done' || item.outcome === 'kept') { // 'kept': expired with a highlight
    d.vault.unshift(item);
    d.vault.sort((a, b) => b.ended_at - a.ended_at || b.id - a.id);
  } else {
    d.heap.unshift(item);
    d.heap.sort((a, b) => b.ended_at - a.ended_at || b.id - a.id);
  }
}
