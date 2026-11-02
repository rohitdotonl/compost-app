// Service worker: the context menu, the keyboard command (handled by Chrome
// through _execute_action) and the small "already saved" mark on the icon.
import { S } from './strings.js';
import { api, isSavable, NotSetUp, Unauthorized } from './common.js';

const BADGE_COLOR = '#4f6b45';          // moss, same as --accent
const LOOKUP_TTL = 5 * 60 * 1000;       // cache a lookup per URL this long
const LOOKUP_RETRY = 10 * 60 * 1000;    // after a 404, don't ask again for this long
const FLASH_MS = 2500;                  // how long a result shows on the badge
const DEBOUNCE_MS = 300;

const lookups = new Map();              // url -> { status, at }
let lookupUnsupportedUntil = 0;
let debounceTimer = null;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'save-link', title: S.menuSaveLink, contexts: ['link'] });
    chrome.contextMenus.create({ id: 'save-page', title: S.menuSavePage, contexts: ['page'] });
  });
});

chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: '#ffffff' });

// ---------------------------------------------------------------------------
// Context menu

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.menuItemId === 'save-link' ? info.linkUrl : info.pageUrl;
  const title = info.menuItemId === 'save-link' ? info.linkText || '' : tab?.title || '';
  saveQuietly(url, title, tab?.id);
});

// Saves without a popup and shows the result on the badge for a moment. When
// the rack is full, the popup page opens as a small window to pick a drop.
async function saveQuietly(url, title, tabId) {
  if (!isSavable(url)) return flash(tabId, S.badgeFailed);
  let data;
  try {
    ({ data } = await api('/api/items', { url, title }));
  } catch (err) {
    if (err instanceof NotSetUp || err instanceof Unauthorized) chrome.runtime.openOptionsPage();
    return flash(tabId, S.badgeFailed);
  }
  switch (data.status) {
    case 'saved':
    case 'in_rack':
      remember(url, 'in_rack');
      return flash(tabId, S.badgeSaved);
    case 'in_vault':
      remember(url, 'in_vault');
      return flash(tabId, S.badgeSaved);
    case 'full': {
      const page = chrome.runtime.getURL('popup.html') + '?' + new URLSearchParams({ url, title });
      chrome.windows.create({ url: page, type: 'popup', width: 392, height: 600 });
      return flash(tabId, S.badgeFull);
    }
    default:
      return flash(tabId, S.badgeFailed);
  }
}

function flash(tabId, text) {
  if (tabId == null) return;
  setBadge(tabId, text);
  setTimeout(() => chrome.tabs.get(tabId).then((tab) => markTab(tab)).catch(() => {}), FLASH_MS);
}

// ---------------------------------------------------------------------------
// The "already saved" mark

chrome.tabs.onActivated.addListener(({ tabId }) => {
  debounce(() => chrome.tabs.get(tabId).then(markTab).catch(() => {}));
});

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status === 'complete' && tab.active) debounce(() => markTab(tab));
});

// The popup reports what it saved so the mark is right without a lookup.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'saved' && msg.url) {
    remember(msg.url, msg.status);
    if (msg.tabId != null) setBadge(msg.tabId, badgeFor(msg.status));
  }
  sendResponse();
});

function debounce(fn) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(fn, DEBOUNCE_MS);
}

async function markTab(tab) {
  if (!tab || tab.id == null) return;
  if (!isSavable(tab.url)) return setBadge(tab.id, '');
  const status = await lookup(tab.url);
  setBadge(tab.id, badgeFor(status));
}

function badgeFor(status) {
  if (status === 'in_rack') return S.badgeInRack;
  if (status === 'in_vault') return S.badgeInVault;
  return '';
}

// GET /api/lookup?url= → in_rack | in_vault | new. Cached per URL. If the
// server doesn't have the route yet (404), stay quiet and stop asking for a
// while. Any failure counts as "new".
async function lookup(url) {
  const cached = lookups.get(url);
  if (cached && Date.now() - cached.at < LOOKUP_TTL) return cached.status;
  if (Date.now() < lookupUnsupportedUntil) return 'new';
  try {
    const { status, data } = await api('/api/lookup?url=' + encodeURIComponent(url));
    if (status === 404) {
      lookupUnsupportedUntil = Date.now() + LOOKUP_RETRY;
      return 'new';
    }
    remember(url, data.status || 'new');
    return data.status || 'new';
  } catch {
    return 'new';
  }
}

function remember(url, status) {
  lookups.set(url, { status, at: Date.now() });
}

function setBadge(tabId, text) {
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
}
