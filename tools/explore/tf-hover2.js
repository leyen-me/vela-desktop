const { chromium } = require('playwright-core');
const path = require('path');
const OUT = path.join(__dirname, '..', '..', 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const vis = (page) => page.evaluate(() => {
  const content = document.querySelector('[id="menu:vela-menu-10:content"]');
  return {
    contentVisible: !!(content && content.offsetParent !== null),
    labels: [...document.querySelectorAll('.vela-menu-label')].filter((e) => e.offsetParent !== null).map((e) => e.textContent.trim()),
    tf: (document.querySelector('#vela-topbar-tf') || {}).textContent,
  };
});

(async () => {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes('5174')) || ctx.pages()[0];
  await page.bringToFront();

  const box = await page.locator('#vela-topbar-tf').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;

  await page.mouse.click(cx, cy);
  await sleep(400);
  console.log('opened', JSON.stringify(await vis(page)));

  // find the 5m item
  const items = page.locator('.vela-menu-label');
  const count = await items.count();
  let tb = null;
  for (let i = 0; i < count; i++) {
    if ((await items.nth(i).textContent()).trim() === '5m') { tb = await items.nth(i).boundingBox(); break; }
  }
  console.log('5m box', JSON.stringify(tb));

  // move in small steps from trigger through the gap to the item
  const path_ = [cy + 6, cy + 12, cy + 18, cy + 25, cy + 32];
  for (const y of path_) {
    await page.mouse.move(cx, y, { steps: 3 });
    await sleep(180);
    console.log('at y=' + y, JSON.stringify(await vis(page)));
  }
  if (tb) {
    await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 6 });
    await sleep(300);
    console.log('on 5m', JSON.stringify(await vis(page)));
    await page.screenshot({ path: path.join(OUT, 'tf-hover-5m.png') });
  }
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
