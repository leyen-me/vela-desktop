const { chromium } = require('playwright-core');
const path = require('path');
const OUT = path.join(__dirname, '..', '..', 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes('5174')) || ctx.pages()[0];
  await page.bringToFront();

  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[console.' + m.type() + ']', m.text().slice(0, 300)); });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 300)));

  const snap = () => page.evaluate(() => {
    const canvas = [...document.querySelectorAll('canvas')];
    return {
      tf: (document.querySelector('#vela-topbar-tf') || {}).textContent,
      menuOpen: !!(document.querySelector('[id="menu:vela-menu-10:content"]') || {}).offsetParent,
      canvases: canvas.map((c) => ({ w: c.width, h: c.height })),
      symbolText: (document.querySelector('.vela-widget-symbol') || {}).textContent,
    };
  });

  const box = await page.locator('#vela-topbar-tf').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.click(cx, cy);
  await sleep(400);
  console.log('opened', JSON.stringify(await snap()));

  const items = page.locator('.vela-menu-label');
  const count = await items.count();
  let tb = null;
  for (let i = 0; i < count; i++) {
    if ((await items.nth(i).textContent()).trim() === '5m') { tb = await items.nth(i).boundingBox(); break; }
  }
  console.log('5m box', JSON.stringify(tb));
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 6 });
  await sleep(200);
  await page.mouse.down();
  await sleep(60);
  await page.mouse.up();
  console.log('after click 5m (t+0)', JSON.stringify(await snap()));
  await sleep(800);
  console.log('t+800', JSON.stringify(await snap()));
  await page.screenshot({ path: path.join(OUT, 'tf-switch-5m.png') });
  await sleep(2500);
  console.log('t+3300', JSON.stringify(await snap()));
  await page.screenshot({ path: path.join(OUT, 'tf-switch-5m-late.png') });
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
