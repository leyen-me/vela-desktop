const { chromium } = require('playwright-core');
const path = require('path');
const OUT = path.join(__dirname, '..', '..', 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(page, tag) {
  const info = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.vela-menu-label')].filter((e) => e.offsetParent !== null);
    if (!items.length) return { open: false };
    const first = items[0];
    // find positioned popover ancestor
    let anc = first, chain = [];
    while (anc && anc !== document.body) {
      const cs = getComputedStyle(anc);
      if (cs.position === 'absolute' || cs.position === 'fixed' || /popover|menu|dropdown|portal/i.test(anc.className || '')) {
        chain.push({ cls: anc.className, pos: cs.position, pe: cs.pointerEvents, rect: anc.getBoundingClientRect().toJSON(), z: cs.zIndex });
      }
      anc = anc.parentElement;
    }
    return { open: true, items: items.map((e) => e.textContent.trim()), firstRect: first.getBoundingClientRect().toJSON(), chain: chain.slice(0, 6) };
  });
  console.log(`[${tag}]`, JSON.stringify(info, null, 1));
  return info;
}

(async () => {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes('5174')) || ctx.pages()[0];
  await page.bringToFront();

  const box = await page.locator('.vela-widget-tf-caret').first().boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;

  // hover the trigger
  await page.mouse.move(cx - 60, cy + 20, { steps: 5 });
  await page.mouse.move(cx, cy, { steps: 10 });
  await sleep(700);
  await probe(page, 'hover-trigger');
  await page.screenshot({ path: path.join(OUT, 'tf-h1-trigger.png') });

  // move downward toward where the menu should be (just below trigger)
  await page.mouse.move(cx, cy + 25, { steps: 6 });
  await sleep(500);
  await probe(page, 'moved-down-25');
  await page.screenshot({ path: path.join(OUT, 'tf-h2-down.png') });

  // move to the first visible menu label
  const items = page.locator('.vela-menu-label');
  const cnt = await items.count();
  for (let i = 0; i < cnt; i++) {
    if ((await items.nth(i).textContent()).trim() === '5m') {
      const ib = await items.nth(i).boundingBox();
      if (ib) {
        await page.mouse.move(ib.x + ib.width / 2, ib.y + ib.height / 2, { steps: 8 });
        await sleep(500);
        await probe(page, 'moved-to-5m');
        await page.screenshot({ path: path.join(OUT, 'tf-h3-item.png') });
      }
      break;
    }
  }
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
