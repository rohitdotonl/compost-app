// The daily reminder's footer line (Phase 8): "Daily reminder: off · Turn on".
// Off by default and hidden where Web Push isn't available. Turning it on
// asks for notification permission, then for an hour, then subscribes this
// browser with the Worker's VAPID key. The pushes carry nothing: sw.js asks
// GET /api/digest for the words, with the passcode this page leaves for it
// in the Cache API (a service worker can't read localStorage).
import { S } from './strings.js';
import { api, el, getPasscode } from './api.js';

const PUSH_CACHE = 'compost-push';     // kept across shell updates by sw.js
const PUSH_KEY = '/__compost/push';
const DEFAULT_HOUR = 8;

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && 'caches' in window;
}

// The local time zone as minutes to add to UTC (the Worker's convention).
const tzOffset = () => -new Date().getTimezoneOffset();

export function createNotify() {
  const element = el('div', { className: 'notify', hidden: true, role: 'group', 'aria-label': S.reminderLabel });
  let on = false;
  let hour = DEFAULT_HOUR;
  let mode = 'idle'; // 'idle' (off or on, at rest) or 'pick' (choosing the hour)
  let note = '';     // one quiet sentence under the line, when something went wrong

  // Reads this browser's subscription and the Worker's preferences. Also
  // keeps the time zone current (summer time) and the passcode fresh for sw.js.
  async function load() {
    if (!pushSupported()) return;
    element.hidden = false;
    paint();
    try {
      const sub = await currentSubscription();
      const query = sub ? `?endpoint=${encodeURIComponent(sub.endpoint)}` : '';
      const { status, data } = await api(`/api/push/status${query}`);
      if (status !== 200) return;
      hour = data.hour;
      // Browsers drop a subscription when permission is taken back.
      on = !!sub && data.enabled && data.subscribed;
      paint();
      if (!on) return;
      await leaveForWorker();
      if (data.tzOffset !== tzOffset()) await register(sub, hour);
    } catch {
      // Offline: the line keeps what it last showed.
    }
  }

  function paint() {
    const parts = [];
    if (mode === 'pick') {
      const select = el('select', { 'aria-label': S.reminderHourLabel });
      for (let h = 0; h < 24; h++) select.append(el('option', { value: String(h), selected: h === hour }, S.hourLabel(h)));
      parts.push(
        el('label', {}, `${S.reminderPick} `, select),
        ' · ', button(S.reminderSave, () => turnOn(Number(select.value))),
        ' · ', button(S.reminderCancel, () => { mode = 'idle'; paint(); })
      );
      element.replaceChildren(el('p', {}, ...parts), el('p', { className: 'notify-hint' }, S.reminderHint));
      select.focus();
      return;
    }
    if (on) parts.push(S.reminderAt(S.hourLabel(hour)), ' · ', button(S.reminderChange, pick), ' · ', button(S.reminderTurnOff, turnOff));
    else parts.push(S.reminderOff, ' · ', button(S.reminderTurnOn, ask));
    element.replaceChildren(el('p', {}, ...parts), note ? el('p', { className: 'notify-hint' }, note) : '');
  }

  async function ask() {
    note = '';
    const permission = await Notification.requestPermission().catch(() => 'denied');
    if (permission !== 'granted') {
      note = S.reminderBlocked;
      return paint();
    }
    pick();
  }

  function pick() {
    note = '';
    mode = 'pick';
    paint();
  }

  async function turnOn(chosen) {
    mode = 'idle';
    try {
      const reg = await navigator.serviceWorker.ready;
      const { data } = await api('/api/push/key');
      const key = fromBase64url(data.key);
      let sub = await reg.pushManager.getSubscription();
      // A subscription made with another key (a different deploy) can't be reused.
      if (sub && !sameBytes(sub.options && sub.options.applicationServerKey, key)) {
        await sub.unsubscribe();
        sub = null;
      }
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await leaveForWorker();
      await register(sub, chosen);
      on = true;
      hour = chosen;
    } catch {
      note = S.reminderFailed;
    }
    paint();
  }

  async function turnOff() {
    note = '';
    on = false;
    paint();
    try {
      const sub = await currentSubscription();
      if (sub) await sub.unsubscribe().catch(() => {});
      await api('/api/push/unsubscribe', { endpoint: sub ? sub.endpoint : '' });
      await caches.open(PUSH_CACHE).then((c) => c.delete(PUSH_KEY));
    } catch {
      // The Worker drops a subscription the push service forgets.
    }
  }

  return { element, load };
}

async function register(sub, hour) {
  const { status } = await api('/api/push/subscribe', { subscription: sub.toJSON(), hour, tzOffset: tzOffset() });
  if (status !== 200) throw new Error(String(status));
}

async function currentSubscription() {
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

// What sw.js needs to build the notification: the passcode for
// GET /api/digest and the words to fall back on.
function leaveForWorker() {
  const body = JSON.stringify({ passcode: getPasscode(), title: S.appName, fallback: S.digestFallback });
  return caches.open(PUSH_CACHE).then((c) => c.put(PUSH_KEY, new Response(body, { headers: { 'Content-Type': 'application/json' } })));
}

function button(label, onclick) {
  return el('button', { type: 'button', className: 'link', onclick }, label);
}

function fromBase64url(text) {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function sameBytes(buffer, bytes) {
  if (!buffer) return false;
  const a = new Uint8Array(buffer);
  return a.length === bytes.length && a.every((b, i) => b === bytes[i]);
}
