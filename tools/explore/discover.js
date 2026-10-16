const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', '..', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log('shot ->', file);
}

async function clickVisible(page, text) {
  const ok = await page.evaluate((t) => {
    const all = [...document.querySelectorAll('*')];
    const el = all.find((e) => {
      const own = (e.childElementCount === 0 ? e.textContent : '') || '';
      return own.trim() === t && e.offsetParent !== null;
    });
    if (el) {
      el.click();
      return true;
    }
    const any = all.find((e) => (e.textContent || '').trim() === t && e.offsetParent !== null);
    if (any) {
      any.click();
      return true;
    }
    return false;
  }, text);
  console.log(`click "${text}" -> ${ok}`);
  return ok;
}

async function main() {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const ctx = browser.contexts()[0];
  const page = (ctx.pages().find((p) => p.url().includes('luxalgo')) || ctx.pages()[0]);
  page.setDefaultTimeout(15000);

  const jsonLog = [];
  page.on('response', async (res) => {
    try {
      const url = res.url();
      const ct = res.headers()['content-type'] || '';
      if (!(ct.includes('json') || url.includes('/api') || url.includes('luxalgo.com') && url.includes('script'))) return;
      let body = '';
      try {
        body = (await res.text()).slice(0, 6000);
      } catch (e) {}
      jsonLog.push({ url, status: res.status(), body });
      console.log('\n[RES]', res.status(), url);
      console.log(body.slice(0, 1200));
    } catch (e) {}
  });

  await page.keyboard.press('Escape');
  await sleep(400);

  const isVisible = (t) =>
    page.evaluate((txt) => {
      return [...document.querySelectorAll('*')].some(
        (e) => e.offsetParent !== null && (e.textContent || '').trim() === txt,
      );
    }, t);

  if (!(await isVisible('All scripts'))) {
    await clickVisible(page, 'Indicators');
    await sleep(2000);
  }
  await shot(page, 'd1-modal');

  await clickVisible(page, 'All scripts');
  await sleep(3000);
  await shot(page, 'd2-allscripts');

  fs.writeFileSync(path.join(__dirname, '..', '..', 'captures', 'net.json'), JSON.stringify(jsonLog, null, 2));

  const overlay = await page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"], .vela-modal, [class*="popup"], [class*="dialog"]');
    return dlg ? dlg.className : 'no dialog found';
  });
  console.log('dialog class:', overlay);

  process.exit(0);
}

main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
