// Loads the unpacked extension in headless Chromium against the mock server
// and walks through the popup's states. Run from the repository root:
//   node extension/dev/smoke.js [screenshot-dir]
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const mock = require('./mock-server.js');

const EXT = path.resolve(__dirname, '..');
const BASE = `http://localhost:${mock.PORT}`;
const SHOTS = process.argv[2] || null;

async function main() {
  const server = await mock.start();
  mock.reset();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compost-ext-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const errors = [];
  context.on('page', (p) => p.on('console', (m) => m.type() === 'error' && errors.push(m.text())));
  context.on('page', (p) => p.on('pageerror', (e) => errors.push(String(e))));

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const id = new URL(sw.url()).host;
  const extUrl = (file) => `chrome-extension://${id}/${file}`;
  console.log('extension id', id);

  // Options page. "Save" asks for the host permission, which headless Chromium
  // never answers, so the test uses "Test connection" (no prompt). Without
  // the permission and without CORS the request is blocked: that message is
  // checked first, then the mock turns CORS on (as the Worker will) and
  // everything else runs through that.
  const options = await context.newPage();
  await options.goto(extUrl('options.html'));
  await options.fill('#address', `localhost:${mock.PORT}`);
  await options.fill('#passcode', 'test');
  await options.click('button:has-text("Test connection")');
  await options.waitForFunction(() => !/Checking/.test(document.querySelector('.status').textContent));
  let status = await options.textContent('.status');
  assert.equal(status, 'Without permission for that address, the extension can’t save.');
  assert.equal(await options.inputValue('#address'), BASE);
  assert.equal(await sw.evaluate(() => chrome.permissions.contains({ origins: ['http://localhost/*'] })), false);
  console.log('no-permission message ok');
  mock.reset({ cors: true });
  await options.click('button:has-text("Test connection")');
  await options.waitForFunction(() => /Connected/.test(document.querySelector('.status').textContent));
  if (SHOTS) await options.screenshot({ path: path.join(SHOTS, 'options.png') });
  await options.close();
  console.log('options connected ok');

  // A page to save, and the popup opened as a tab (chrome-extension://…/popup.html).
  const page1 = await context.newPage();
  await page1.goto(`${BASE}/page/1`);
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 360, height: 480 });

  // 1. Saved: receipt + chips + note.
  await openPopup(popup, extUrl, `${BASE}/page/1`, 'Page 1');
  await popup.waitForSelector('.chips');
  let receipt = await popup.textContent('.receipt');
  assert.match(receipt, /^Slot 1 of 10 used\. Expires \w+\.$/);
  assert.equal(await popup.textContent('.page .title'), 'Page 1');
  assert.deepEqual(await popup.$$eval('.chips button', (b) => b.map((x) => x.textContent)), ['Tonight', 'Commute', 'Weekend']);
  if (SHOTS) await popup.screenshot({ path: path.join(SHOTS, 'popup-saved-light.png') });
  await popup.emulateMedia({ colorScheme: 'dark' });
  if (SHOTS) await popup.screenshot({ path: path.join(SHOTS, 'popup-saved-dark.png') });
  await popup.emulateMedia({ colorScheme: 'light' });
  await popup.click('.chips button:has-text("Tonight")');
  await popup.waitForSelector('.chips button[aria-pressed="true"]');
  assert.equal(mock.state.intents[1], 'tonight');
  await popup.click('.chips button:has-text("Tonight")');
  await popup.waitForFunction(() => !document.querySelector('.chips button[aria-pressed="true"]'));
  assert.equal(mock.state.intents[1], null);
  await popup.fill('.note input', 'For the talk on Thursday');
  await popup.press('.note input', 'Enter');
  await popup.waitForSelector('.note .meta');
  assert.equal(mock.state.notes[1], 'For the talk on Thursday');
  console.log('saved receipt ok:', receipt);

  // 2. Already in the rack.
  await openPopup(popup, extUrl, `${BASE}/page/1`, 'Page 1');
  await popup.waitForSelector('.receipt:not(.quiet)');
  assert.equal(await popup.textContent('.receipt'), 'Already in your rack');
  console.log('in_rack ok');

  // 3. Already in the vault.
  mock.reset({ vault: [`${BASE}/page/7`] });
  await openPopup(popup, extUrl, `${BASE}/page/7`, 'Page 7');
  await popup.waitForSelector('.receipt:not(.quiet)');
  assert.equal(await popup.textContent('.receipt'), 'Already in your vault');
  console.log('in_vault ok');

  // 4. Rack full: ten radios, Cancel saves nothing, Drop and save re-posts with dropId.
  mock.reset({ rack: 10 });
  await openPopup(popup, extUrl, `${BASE}/page/42`, 'Page 42');
  await popup.waitForSelector('.choices');
  assert.equal(await popup.textContent('.receipt'), 'Your rack is full. Drop one to make room.');
  assert.equal((await popup.$$('.choices input[type="radio"]')).length, 10);
  assert.equal(await popup.isDisabled('button[type="submit"]'), true);
  if (SHOTS) await popup.screenshot({ path: path.join(SHOTS, 'popup-full.png') });
  await popup.click('button:has-text("Cancel")');
  await popup.waitForSelector('.receipt.quiet');
  assert.equal(await popup.textContent('.receipt'), 'Nothing saved.');
  assert.equal(mock.state.rack.length, 10);
  assert.ok(!mock.state.rack.some((i) => i.url.endsWith('/page/42')));

  await openPopup(popup, extUrl, `${BASE}/page/42`, 'Page 42');
  await popup.waitForSelector('.choices');
  await popup.check('.choices input[value="3"]');
  assert.equal(await popup.isDisabled('button[type="submit"]'), false);
  await popup.fill('.note input', 'Replaces the one I never opened');
  await popup.click('button[type="submit"]');
  await popup.waitForSelector('.chips');
  receipt = await popup.textContent('.receipt');
  assert.match(receipt, /^Slot 10 of 10 used\./);
  assert.ok(!mock.state.rack.some((i) => i.id === 3));
  const saved = mock.state.rack.find((i) => i.url.endsWith('/page/42'));
  assert.ok(saved);
  assert.equal(mock.state.notes[saved.id], 'Replaces the one I never opened');
  assert.equal((await popup.$$('.note input')).length, 0, 'note field hidden once a note was sent');
  console.log('full flow ok:', receipt);

  // 5. A page Compost can't save (chrome://) and a server-side invalid_url.
  mock.reset();
  await popup.goto(extUrl('popup.html?url=chrome://extensions/'));
  await popup.waitForSelector('.receipt.quiet');
  assert.equal(await popup.textContent('.receipt'), 'This isn’t a page Compost can save.');
  const newtab = await context.newPage();
  await newtab.goto('chrome://version/');
  await newtab.bringToFront();
  const popupOnChrome = await context.newPage();
  await popupOnChrome.goto(extUrl('popup.html'));
  await popupOnChrome.waitForSelector('.receipt.quiet');
  await popupOnChrome.close();
  await newtab.close();
  console.log('chrome:// ok');

  // 6. Wrong passcode → link to the options page.
  await sw.evaluate(() => chrome.storage.local.set({ settings: { address: 'http://localhost:8791', passcode: 'nope' } }));
  await openPopup(popup, extUrl, `${BASE}/page/1`, 'Page 1');
  await popup.waitForSelector('.footer a');
  assert.equal(await popup.textContent('.receipt'), 'That passcode didn’t work.');
  assert.equal(await popup.textContent('.footer a'), 'Open settings');
  await sw.evaluate(() => chrome.storage.local.set({ settings: { address: 'http://localhost:8791', passcode: 'test' } }));
  console.log('401 ok');

  // 7. Not set up at all.
  await sw.evaluate(() => chrome.storage.local.clear());
  await openPopup(popup, extUrl, `${BASE}/page/1`, 'Page 1');
  await popup.waitForSelector('.footer a');
  assert.equal(await popup.textContent('.receipt'), 'Tell the extension where your Compost lives.');
  await sw.evaluate(() => chrome.storage.local.set({ settings: { address: 'http://localhost:8791', passcode: 'test' } }));
  console.log('not set up ok');

  // 8. The badge mark: rack "•", vault "✓", new "", and silence on a 404.
  mock.reset({ rack: 2, vault: [`${BASE}/page/7`] });
  await popup.close();
  await page1.close();
  const badge = async (url) => {
    const tab = await context.newPage();
    await tab.goto(url);
    await tab.bringToFront();
    await tab.waitForTimeout(900);
    const tabId = await sw.evaluate(() => chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((t) => t[0]?.id));
    const text = await sw.evaluate((tabId) => chrome.action.getBadgeText({ tabId }), tabId);
    await tab.close();
    return text;
  };
  assert.equal(await badge(`${BASE}/page/1`), '•');
  assert.equal(await badge(`${BASE}/page/7`), '✓');
  assert.equal(await badge(`${BASE}/page/500`), '');
  mock.reset({ rack: 2, lookup: false });
  assert.equal(await badge(`${BASE}/page/2`), '');
  console.log('badge ok');

  // 9. Context menu handler, invoked directly (Chromium has no way to right-click
  // a menu item from automation). Chrome's event objects expose dispatch().
  mock.reset();
  const target = await context.newPage();
  await target.goto(`${BASE}/page/9`);
  await target.bringToFront();
  await target.waitForTimeout(800); // let the tab's own mark settle first
  const tabId = await sw.evaluate(() => chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((t) => t[0]?.id));
  const canDispatch = await sw.evaluate(() => typeof chrome.contextMenus.onClicked.dispatch === 'function');
  if (canDispatch) {
    await sw.evaluate(({ tabId, link }) => {
      chrome.contextMenus.onClicked.dispatch({ menuItemId: 'save-link', linkUrl: link, linkText: 'A link', pageUrl: 'x' }, { id: tabId, title: 'Page 9' });
    }, { tabId, link: `${BASE}/page/99` });
    await target.waitForTimeout(500);
    assert.ok(mock.state.rack.some((i) => i.url.endsWith('/page/99')), 'context menu saved the link');
    assert.equal(await sw.evaluate((tabId) => chrome.action.getBadgeText({ tabId }), tabId), 'ok');
    await sw.evaluate(({ tabId, link }) => {
      chrome.contextMenus.onClicked.dispatch({ menuItemId: 'save-page', pageUrl: link }, { id: tabId, title: 'Page 9' });
    }, { tabId, link: `${BASE}/page/9` });
    await target.waitForTimeout(500);
    assert.ok(mock.state.rack.some((i) => i.url.endsWith('/page/9')), 'context menu saved the page');
    await target.waitForTimeout(2800); // the flash gives way to the mark
    assert.equal(await sw.evaluate((tabId) => chrome.action.getBadgeText({ tabId }), tabId), '•');
    console.log('context menu ok');
  } else {
    console.log('context menu: onClicked.dispatch unavailable, handler not exercised');
  }
  await target.close();

  await context.close();
  server.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
  // Chrome logs every non-2xx response and the CORS block as console errors;
  // the test provokes those on purpose. Anything else is a real error.
  const real = errors.filter((e) => !/Failed to load resource|blocked by CORS policy/.test(e));
  if (real.length) {
    console.log('console errors:', real);
    process.exit(1);
  }
  console.log('all good, no console errors');
}

async function openPopup(popup, extUrl, url, title) {
  await popup.goto(extUrl('popup.html') + '?' + new URLSearchParams({ url, title }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
