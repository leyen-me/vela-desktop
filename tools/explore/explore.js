const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', '..', 'shots');
fs.mkdirSync(OUT, { recursive: true });

async function main() {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const ctx = browser.contexts()[0];
  const pages = ctx.pages();
  const page = pages.find((p) => p.url().includes('luxalgo')) || pages[0];
  console.log('page url:', page.url());

  const stamp = Date.now();
  const file = path.join(OUT, `shot-${stamp}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log('saved', file);

  const info = await page.evaluate(() => {
    const links = [...document.querySelectorAll('a')]
      .map((a) => ({ text: (a.innerText || '').trim(), href: a.href }))
      .filter((l) => l.text && l.href)
      .slice(0, 60);
    const buttons = [...document.querySelectorAll('button')]
      .map((b) => (b.innerText || '').trim())
      .filter(Boolean)
      .slice(0, 40);
    return { title: document.title, url: location.href, links, buttons };
  });
  console.log(JSON.stringify(info, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
