const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', '..', 'shots');
fs.mkdirSync(OUT, { recursive: true });

async function connect() {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const ctx = browser.contexts()[0];
  const pages = ctx.pages();
  const page = pages.find((p) => p.url().includes('luxalgo')) || pages[0];
  page.setDefaultTimeout(15000);
  return page;
}

async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log('shot ->', file);
  return file;
}

async function dumpText(page) {
  const t = await page.evaluate(() => document.body.innerText.slice(0, 4000));
  console.log('--- VISIBLE TEXT ---\n' + t);
}

async function main() {
  const step = process.argv[2] || 'shot';
  const arg = process.argv[3];
  const page = await connect();

  if (step === 'net') {
    page.on('response', async (res) => {
      try {
        const url = res.url();
        const ct = res.headers()['content-type'] || '';
        const isJson = ct.includes('json') || url.includes('/api') || url.includes('graphql') || url.includes('trpc');
        if (!isJson) return;
        let body = '';
        try {
          body = (await res.text()).slice(0, 4000);
        } catch (e) {
          body = '<no body>';
        }
        console.log('\n[RES]', res.status(), url);
        console.log(body);
      } catch (e) {}
    });
    await page.waitForTimeout(300);
    const target = arg || 'All scripts';
    await page.getByText(target, { exact: false }).first().click();
    await page.waitForTimeout(3000);
    await shot(page, 'net-' + target.replace(/\W+/g, '_'));
    await dumpText(page);
  } else if (step === 'indicators') {
    await page.getByText('Indicators', { exact: true }).first().click();
    await page.waitForTimeout(1500);
    await shot(page, 'indicators-menu');
    await dumpText(page);
  } else if (step === 'click') {
    await page.getByText(arg, { exact: true }).first().click();
    await page.waitForTimeout(1500);
    await shot(page, 'after-click-' + arg.replace(/\W+/g, '_'));
    await dumpText(page);
  } else if (step === 'shot') {
    await page.waitForTimeout(1000);
    await shot(page, 'shot-' + Date.now());
    await dumpText(page);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
