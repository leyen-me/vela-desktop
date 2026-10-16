const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', '..', 'shots');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function clickVisible(page, text) {
  return page.evaluate((t) => {
    const all = [...document.querySelectorAll('*')];
    let el = all.find(
      (e) => (e.childElementCount === 0 ? (e.textContent || '').trim() : '') === t && e.offsetParent !== null,
    );
    if (!el) el = all.find((e) => (e.textContent || '').trim() === t && e.offsetParent !== null);
    if (el) {
      el.click();
      return true;
    }
    return false;
  }, text);
}

async function main() {
  const [action, ...args] = process.argv.slice(2);
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes('luxalgo')) || ctx.pages()[0];
  page.setDefaultTimeout(15000);

  const net = [];
  page.on('response', async (res) => {
    try {
      const url = res.url();
      const ct = res.headers()['content-type'] || '';
      if (!(ct.includes('json') || /\/api\/|graphql|trpc/.test(url))) return;
      if (/_next\/static/.test(url)) return;
      let body = '';
      try {
        body = (await res.text()).slice(0, 5000);
      } catch (e) {}
      net.push({ url, status: res.status(), body });
      console.log('[NET]', res.status(), url);
      console.log('     ', body.slice(0, 500).replace(/\n/g, ' '));
    } catch (e) {}
  });

  if (action === 'click') {
    for (const t of args) {
      const ok = await clickVisible(page, t);
      console.log(`click "${t}" -> ${ok}`);
      await sleep(2000);
    }
  } else if (action === 'goto') {
    await page.goto(args[0], { waitUntil: 'domcontentloaded' });
    console.log('goto', args[0]);
    await sleep(3000);
  } else if (action === 'eval') {
    const r = await page.evaluate(args[0]);
    console.log(JSON.stringify(r, null, 2).slice(0, 5000));
  } else if (action === 'esc') {
    await page.keyboard.press('Escape');
  }

  await sleep(1500);
  const name = `act-${Date.now()}.png`;
  await page.screenshot({ path: path.join(OUT, name) });
  console.log('shot ->', name);
  const text = await page.evaluate(() => document.body.innerText.slice(0, 3500));
  console.log('--- TEXT ---\n' + text);
  process.exit(0);
}

main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
