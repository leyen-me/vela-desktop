const { chromium } = require('playwright-core');
const path = require('path');
const OUT = path.join(__dirname, '..', '..', 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = (page) => page.evaluate(() => {
  const t = document.querySelector('#vela-topbar-tf');
  const content = document.querySelector('[id="menu:vela-menu-10:content"]');
  return {
    tfText: t && t.textContent.trim(),
    expanded: t && t.getAttribute('aria-expanded'),
    dataState: t && t.getAttribute('data-state'),
    contentExists: !!content,
    contentVisible: !!(content && content.offsetParent !== null),
    contentRect: content ? content.getBoundingClientRect().toJSON() : null,
    labelsVisible: [...document.querySelectorAll('.vela-menu-label')].filter((e) => e.offsetParent !== null).map((e) => e.textContent.trim()),
  };
});

(async () => {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes('5174')) || ctx.pages()[0];
  await page.bringToFront();
  const box = await page.locator('#vela-topbar-tf').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;

  console.log('before', JSON.stringify(await state(page)));
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await sleep(80);
  console.log('mousedown', JSON.stringify(await state(page)));
  await page.mouse.up();
  await sleep(120);
  console.log('mouseup+120ms', JSON.stringify(await state(page)));
  await sleep(400);
  console.log('mouseup+520ms', JSON.stringify(await state(page)));
  await page.screenshot({ path: path.join(OUT, 'tf-state-1.png') });

  // try clicking again (toggle)
  await page.mouse.click(cx, cy);
  await sleep(300);
  console.log('second click', JSON.stringify(await state(page)));
  await page.screenshot({ path: path.join(OUT, 'tf-state-2.png') });
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
