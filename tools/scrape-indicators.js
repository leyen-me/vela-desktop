const fs = require('fs');
const path = require('path');

const BASE = 'https://app.luxalgo.com/api/library';
const OUT = path.join(__dirname, '..', 'data');
const PINE = path.join(OUT, 'pine');
const META = path.join(OUT, 'indicators.json');
const CONCURRENCY = 6;
const DELAY_MS = 80;

fs.mkdirSync(PINE, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safe(s) {
  return s.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '');
}

async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (res.status === 429) throw new Error('429');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(500 * (i + 1));
    }
  }
}

async function main() {
  console.log('fetching catalog...');
  const cat = await getJson(`${BASE}/indicators/query?fields=card&sort=name&pageIndex=0&pageQuantity=1000`);
  const list = cat.data.indicators;
  console.log('indicators:', list.length);

  const results = [];
  let done = 0;
  let failed = [];

  async function worker(queue) {
    while (queue.length) {
      const ind = queue.shift();
      try {
        const j = await getJson(`${BASE}/indicators/by-slug/${encodeURIComponent(ind.slug)}`);
        const d = j.data || {};
        const code =
          typeof d.pineScriptCode === 'string'
            ? d.pineScriptCode
            : d.pineScriptCode?.code || '';
        if (code) {
          const dir = path.join(PINE, safe(ind.family || 'unknown'));
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, `${safe(ind.slug)}.pine`), code);
        } else {
          failed.push({ slug: ind.slug, reason: 'no code' });
        }
        results.push({
          id: ind.id,
          name: ind.name,
          slug: ind.slug,
          family: ind.family,
          authorName: ind.authorName,
          tags: (ind.tags || []).map((t) => t.name),
          creationDate: ind.creationDateDisplayed,
          description: ind.description,
          pineLen: code.length,
        });
      } catch (e) {
        failed.push({ slug: ind.slug, reason: e.message });
      }
      done++;
      if (done % 25 === 0) console.log(`  ${done}/${list.length}`);
      await sleep(DELAY_MS);
    }
  }

  const queue = list.slice();
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));

  fs.writeFileSync(META, JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(OUT, 'failed.json'), JSON.stringify(failed, null, 2));
  console.log(`\nDONE. saved ${results.length} pine files, ${failed.length} failed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
