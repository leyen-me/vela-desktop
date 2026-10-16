const { chromium } = require('playwright-core');
const path = require('path');
const OUT = path.join(__dirname, '..', '..', 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes('5174')) || ctx.pages()[0];
  await page.bringToFront();

  // 1) click the timeframe trigger
  const trig = page.locator('.vela-widget-tf-caret').first();
  const box = await trig.boundingBox();
  console.log('trigger box', box);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(600);
  const afterClick = await page.evaluate(() => ({
    menuItems: [...document.querySelectorAll('.vela-menu-label')].filter(e => e.offsetParent !== null).map(e => e.textContent.trim()),
    popovers: [...document.querySelectorAll('[class*="popover"],[class*="dropdown"],[class*="menu-list"]')].filter(e => e.offsetParent !== null).map(e => e.className),
  }));
  console.log('after click ->', JSON.stringify(afterClick));
  await page.screenshot({ path: path.join(OUT, 'tf-1-open.png') });

  // 2) find the "5m" menu item, hover it
  const items = page.locator('.vela-menu-label');
  const n = await items.count();
  let target = null;
  for (let i = 0; i < n; i++) {
    const t = (await items.nth(i).textContent()).trim();
    if (t === '5m') { target = items.nth(i); break; }
  }
  if (target) {
    const ib = await target.boundingBox();
    console.log('5m item box', ib);
    // first move to it
    await page.mouse.move(ib.x + ib.width / 2, ib.y + ib.height / 2, { steps: 8 });
    await sleep(400);
    const onHover = await page.evaluate(() => ({
      visible: [...document.querySelectorAll('.vela-menu-label')].filter(e => e.offsetParent !== null).map(e => e.textContent.trim()),
    }));
    console.log('on hover ->', JSON.stringify(onHover));
    await page.screenshot({ path: path.join(OUT, 'tf-2-hover.png') });

    // 3) click it
    await page.mouse.click(ib.x + ib.width / 2, ib.y + ib.height / 2);
    await sleep(1500);
    const afterPick = await page.evaluate(() => {
      const t = document.querySelector('.vela-widget-tf-caret');
      return { tfNow: t ? t.textContent.trim() : null };
    });
    console.log('after pick ->', JSON.stringify(afterPick));
    await page.screenshot({ path: path.join(OUT, 'tf-3-picked.png') });
  }
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
