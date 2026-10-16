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
      if (/_next\/static/.test(url)) return;
      if (!(ct.includes('json') || /\/api\/|scripts|indicator|pine/i.test(url))) return;
      let body = '';
      try { body = (await res.text()).slice(0, 3000); } catch (e) {}
      console.log('\n[NET]', res.status(), url);
      console.log(body.slice(0, 400).replace(/\n/g, ' '));
    } catch (e) {}
  });

  await page.keyboard.press('Escape').catch(() => {});
  await sleep(500);

  // hover the chart legend entry for an on-chart indicator
  const legend = page.locator('text=/Smart Money Concepts/').first();
  console.log('legend hits:', await legend.count());
  await legend.hover({ force: true }).catch((e) => console.log('hover err', e.message));
  await sleep(1200);
  await page.screenshot({ path: path.join(OUT, 'legend-hover.png') });
  console.log('shot legend-hover.png');

  // find the <> toggle (code icon) and click
  const clicked = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button,[role=button],svg')];
    for (const b of btns) {
      const t = (b.getAttribute('aria-label') || b.getAttribute('title') || '').toLowerCase();
      if (t.includes('source') || t.includes('code') || t.includes('pine')) { b.click(); return t; }
    }
    return null;
  });
  console.log('clicked code toggle:', clicked);
  await sleep(2500);
  await page.screenshot({ path: path.join(OUT, 'legend-code.png') });
  console.log('shot legend-code.png');

  process.exit(0);
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
