const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes('luxalgo')) || ctx.pages()[0];
  page.setDefaultTimeout(20000);

  const reqs = [];
  page.on('request', (r) => reqs.push({ m: r.method(), url: r.url() }));

  console.log('reloading...');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(4000);

  // open indicators modal
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(300);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('*')].find(
      (e) => e.offsetParent !== null && (e.textContent || '').trim() === 'Indicators',
    );
    if (el) el.click();
  });
  await sleep(3500);

  fs.writeFileSync(path.join(__dirname, '..', '..', 'captures', 'reqs.json'), JSON.stringify(reqs, null, 2));

  const interesting = reqs.filter((r) => /script|indicator|library|quant|v1|graphql|\.js(\?|$)/i.test(r.url));
  console.log(`total ${reqs.length} requests. interesting:`);
  const seen = new Set();
  for (const r of interesting) {
    const key = r.url.split('?')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(' ', r.m, r.url.slice(0, 160));
  }

  process.exit(0);
}

main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
