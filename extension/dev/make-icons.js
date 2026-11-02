// Rasterises public/icons/icon.svg to the PNG sizes the manifest needs.
// Run from the repository root: node extension/dev/make-icons.js
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const SIZES = [16, 32, 48, 128];
const root = path.resolve(__dirname, '..', '..');
const svg = fs.readFileSync(path.join(root, 'public', 'icons', 'icon.svg'), 'utf8');
const out = path.join(root, 'extension', 'icons');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const size of SIZES) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`
    );
    const file = path.join(out, `icon-${size}.png`);
    await page.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    console.log('wrote', path.relative(root, file));
  }
  await browser.close();
})();
