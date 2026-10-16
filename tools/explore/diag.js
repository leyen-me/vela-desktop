const { chromium } = require('playwright-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes('localhost:5173')) || ctx.pages()[0];
  page.setDefaultTimeout(15000);

  page.on('console', (m) => console.log('[console.' + m.type() + ']', m.text()));
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('requestfailed', (r) => console.log('[reqfail]', r.url(), r.failure()?.errorText));
  page.on('response', (r) => {
    if (r.url().includes('/api/bars')) console.log('[bars]', r.status(), r.url());
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(6000);
  console.log('--- done ---');
  process.exit(0);
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
