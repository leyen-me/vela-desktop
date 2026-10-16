const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', '..', 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes('luxalgo')) || ctx.pages()[0];
  page.setDefaultTimeout(15000);

  page.on('response', async (res) => {
    try {
      const url = res.url();
      const ct = res.headers()['content-type'] || '';
      if (!(ct.includes('json') || /\/api\/|graphql/.test(url))) return;
      if (/_next\/static/.test(url)) return;
      let body = '';
      try {
        body = (await res.text()).slice(0, 8000);
      } catch (e) {}
      if (body.length > 20) {
        console.log('\n[NET]', res.status(), url);
        console.log(body.slice(0, 800).replace(/\n/g, ' '));
      }
    } catch (e) {}
  });

  // ensure chart page
  if (!page.url().includes('/chart')) {
    await page.goto('https://vela.luxalgo.com/chart', { waitUntil: 'domcontentloaded' });
    await sleep(4000);
  }
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(400);

  // open indicators
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('*')].find(
      (e) => e.offsetParent !== null && (e.textContent || '').trim() === 'Indicators',
    );
    if (el) el.click();
  });
  await sleep(2500);

  // find first indicator card and hover
  const card = page.locator('text=Hull Butterfly Oscillator').first();
  const cnt = await card.count();
  console.log('card hits:', cnt);
  if (cnt) {
    await card.hover();
    await sleep(800);
    await page.screenshot({ path: path.join(OUT, 'hover-card.png') });
    console.log('shot -> hover-card.png');
  } else {
    await page.screenshot({ path: path.join(OUT, 'hover-card.png') });
    console.log('no card; shot current');
  }

  process.exit(0);
}

main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
