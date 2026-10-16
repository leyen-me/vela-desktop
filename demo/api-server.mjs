import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PINE_DIR = path.join(ROOT, 'data', 'pine');
const DIST = path.join(__dirname, 'dist');
const CACHE_DIR = path.join(ROOT, 'data', 'cache');
const DB_FILE = path.join(CACHE_DIR, 'bars.sqlite');

// --- Longbridge: force the international gateway ---
process.env.LONGPORT_HTTP_URL ||= 'https://openapi.longportapp.com';
process.env.LONGPORT_QUOTE_WS_URL ||= 'wss://openapi-quote.longportapp.com/v2';
process.env.LONGPORT_TRADE_WS_URL ||= 'wss://openapi-trade.longportapp.com/v2';

const { Config, QuoteContext, Period, AdjustType, TradeSessions, NaiveDate, NaiveDatetime, Time, Market } =
  await import('longport');

const TF = {
  '1m': Period.Min_1, '5m': Period.Min_5, '15m': Period.Min_15, '30m': Period.Min_30,
  '1h': Period.Min_60, '2h': Period.Min_120, '4h': Period.Min_240,
  '1d': Period.Day, '1w': Period.Week, '1M': Period.Month,
};

// Longbridge caps a single candlestick request at 1000 bars — deeper windows page.
const PAGE = 1000;
// Hard ceiling for one HTTP request from the client (Vela backfills in ~10000-bar chunks).
const MAX_LIMIT = 50000;

// Longbridge history anchors are NAIVE datetimes interpreted in the MARKET's timezone.
const TZ_BY_SUFFIX = [
  ['.US', 'America/New_York'], ['.HK', 'Asia/Hong_Kong'],
  ['.SH', 'Asia/Shanghai'], ['.SZ', 'Asia/Shanghai'],
];
function tzForSymbol(symbol) {
  const hit = TZ_BY_SUFFIX.find(([s]) => symbol.endsWith(s));
  return hit ? hit[1] : 'UTC';
}
function toNaiveDatetime(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date(ms));
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  return new NaiveDatetime(new NaiveDate(g('year'), g('month'), g('day')), new Time(g('hour') % 24, g('minute'), g('second')));
}

// ---------------- SQLite cache (built-in node:sqlite, WAL) ----------------
fs.mkdirSync(CACHE_DIR, { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');
db.exec(`CREATE TABLE IF NOT EXISTS bars (
  symbol TEXT NOT NULL, tf TEXT NOT NULL, time INTEGER NOT NULL,
  open REAL, high REAL, low REAL, close REAL, volume REAL,
  PRIMARY KEY (symbol, tf, time));`);
db.exec(`CREATE TABLE IF NOT EXISTS meta (
  symbol TEXT NOT NULL, tf TEXT NOT NULL, fetched_at INTEGER NOT NULL,
  PRIMARY KEY (symbol, tf));`);

// Oldest open-time we have PROVEN covered by a fetch (0 = source exhausted going back).
{
  const cols = db.prepare('PRAGMA table_info(meta)').all().map((c) => c.name);
  if (!cols.includes('covered_from')) db.exec('ALTER TABLE meta ADD COLUMN covered_from INTEGER');
}

const qCount = db.prepare('SELECT COUNT(*) AS n FROM bars WHERE symbol=? AND tf=?');
const qFetchedAt = db.prepare('SELECT fetched_at, covered_from FROM meta WHERE symbol=? AND tf=?');
const qGet = db.prepare(
  'SELECT time,open,high,low,close,volume FROM bars WHERE symbol=? AND tf=? ORDER BY time DESC LIMIT ?',
);
const qGetWindow = db.prepare(
  `SELECT time,open,high,low,close,volume FROM bars
   WHERE symbol=? AND tf=? AND (? IS NULL OR time<=?) AND (? IS NULL OR time>=?)
   ORDER BY time DESC LIMIT ?`,
);
const qPutBar = db.prepare(
  `INSERT INTO bars (symbol,tf,time,open,high,low,close,volume) VALUES (?,?,?,?,?,?,?,?)
   ON CONFLICT(symbol,tf,time) DO UPDATE SET open=excluded.open,high=excluded.high,
     low=excluded.low,close=excluded.close,volume=excluded.volume`,
);
const qPutMeta = db.prepare('INSERT OR REPLACE INTO meta (symbol,tf,fetched_at,covered_from) VALUES (?,?,?,?)');
const qGetCovered = db.prepare('SELECT covered_from FROM meta WHERE symbol=? AND tf=?');

function cacheCount(symbol, tf) {
  return qCount.get(symbol, tf).n;
}
function cacheFetchedAt(symbol, tf) {
  const r = qFetchedAt.get(symbol, tf);
  return r ? r.fetched_at : 0;
}
function cacheCoveredFrom(symbol, tf) {
  const r = qGetCovered.get(symbol, tf);
  return r ? r.covered_from : null;
}
function cacheGet(symbol, tf, count) {
  return qGet.all(symbol, tf, count).reverse().map((r) => ({
    time: r.time, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
  }));
}
// Newest `limit` cached bars inside [from, to] (either bound null = unbounded), ascending.
function cacheGetWindow(symbol, tf, from, to, limit) {
  return qGetWindow.all(symbol, tf, to, to, from, from, limit).reverse().map((r) => ({
    time: r.time, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
  }));
}
function cachePut(symbol, tf, bars, { hitGenesis = false } = {}) {
  // Coverage is the OLDEST open-time down to which we have a CONTIGUOUS run ending at
  // "now" (0 = the source itself is exhausted). We only extend it for a chunk that
  // CONNECTS to what we already had — a disjoint island (e.g. a request.security range
  // in the distant past) must not widen the claim.
  const prev = cacheCoveredFrom(symbol, tf);
  const asc = [...bars].sort((a, b) => a.time - b.time);
  let next = prev;
  if (asc.length > 0) {
    const newest = asc[asc.length - 1].time;
    const tol = tfToMs(tf) * 3;
    const connects = prev == null || prev === 0 || newest >= prev - tol;
    if (prev === 0) next = 0;
    else if (connects) next = hitGenesis ? 0 : prev == null ? asc[0].time : Math.min(prev, asc[0].time);
  } else if (hitGenesis && prev == null) {
    next = prev; // empty probe with nothing proven yet — make no coverage claim
  }

  db.exec('BEGIN');
  try {
    for (const b of bars) {
      qPutBar.run(symbol, tf, b.time, b.open, b.high, b.low, b.close, b.volume ?? null);
    }
    qPutMeta.run(symbol, tf, Date.now(), next);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const isIntraday = (tf) => /h$/.test(tf) || /m$/.test(tf);
const ttlOf = (tf) => (isIntraday(tf) ? 60_000 : 30 * 60_000);

const TF_MS_UNIT = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, M: 2_592_000_000 };
function tfToMs(tf) {
  return parseInt(tf, 10) * (TF_MS_UNIT[tf.slice(-1)] || 60_000);
}

// ---------------- Longbridge client ----------------
let ctxPromise = null;
function getCtx() {
  if (!ctxPromise) {
    const config = Config.fromApikey(
      process.env.LONGPORT_APP_KEY,
      process.env.LONGPORT_APP_SECRET,
      process.env.LONGPORT_ACCESS_TOKEN,
    );
    ctxPromise = QuoteContext.new(config);
  }
  return ctxPromise;
}

async function withRetry(fn, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 700 * (i + 1)));
    }
  }
  throw lastErr;
}

function toBar(b) {
  return {
    time: Date.parse(b.timestamp),
    open: parseFloat(b.open),
    high: parseFloat(b.high),
    low: parseFloat(b.low),
    close: parseFloat(b.close),
    volume: typeof b.volume === 'number' ? b.volume : parseFloat(b.volume || 0),
  };
}

/**
 * Fetch up to `limit` bars inside [from, to] (both epoch ms, either null = unbounded),
 * walking BACKWARD from `to` (default = now) in 1000-bar pages.
 * Returns { bars (ascending), hitGenesis } — hitGenesis=true means the source has
 * nothing older, so the caller can mark coverage as exhausted.
 */
async function fetchWindow(symbol, tf, from, to, limit) {
  const period = TF[tf];
  const tz = tzForSymbol(symbol);
  const ctx = await getCtx();
  const byTime = new Map();
  let anchor = to; // null -> latest
  let hitGenesis = false;

  const maxPages = Math.ceil(limit / (PAGE - 1)) + 4;
  for (let page = 0; byTime.size < limit && page < maxPages; page++) {
    // The API's backward query is anchor-INCLUSIVE, so an anchored page wastes one
    // slot on the boundary bar we already have — ask for one extra to compensate.
    const want = Math.min(PAGE, limit - byTime.size + (anchor != null ? 1 : 0));
    const anchorDt = anchor == null ? null : toNaiveDatetime(anchor, tz);
    let batch;
    try {
      batch = await withRetry(() =>
        ctx.historyCandlesticksByOffset(symbol, period, AdjustType.NoAdjust, false, anchorDt, want, TradeSessions.Intraday),
      );
    } catch (e) {
      // Longbridge refuses anchors before the venue's history floor (e.g. minute bars
      // begin 2023-10-01) with a "limit" error. If we had already walked down to it that
      // IS the bottom (genesis); an anchor BEYOND the floor that we never reached proves
      // nothing — just return what we have.
      const msg = String(e?.message || e);
      if (byTime.size > 0) hitGenesis = true;
      else if (!/limit|301600|301607/i.test(msg)) throw e;
      break;
    }
    if (!batch || batch.length === 0) {
      if (byTime.size > 0) hitGenesis = true;
      break;
    }
    let oldestNew = Infinity; // oldest bar STRICTLY older than the anchor = real progress
    for (const b of batch) {
      const bar = toBar(b);
      if (anchor != null && bar.time >= anchor) continue; // boundary bar / overlap
      if (bar.time < oldestNew) oldestNew = bar.time;
      if (to != null && bar.time > to) continue;
      if (from != null && bar.time < from) continue;
      byTime.set(bar.time, bar);
    }
    if (oldestNew === Infinity) {
      if (byTime.size > 0) hitGenesis = true; // ran out of older bars -> bottom reached
      break;
    }
    if (from != null && oldestNew <= from) break;
    anchor = oldestNew;
  }

  const bars = [...byTime.values()].sort((a, b) => a.time - b.time);
  return { bars, hitGenesis };
}

// ---------------- helpers ----------------
function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'access-control-allow-origin': '*' });
  res.end(body);
}

let idxCache = null;
// Indicator folders → picker group labels, in display order. The picker groups the
// catalogue by `category`, so this is both the label and the ordering.
const FAMILY_LABELS = {
  trend: '趋势',
  momentum: '动量',
  volatility: '波动率',
  'volume-orderflow': '成交量与订单流',
  levels: '关键价位',
  'market-structure': '市场结构',
  patterns: '形态',
  'elliott-harmonics': '艾略特与谐波',
  wyckoff: '威科夫',
  'smc-ict': 'SMC / ICT',
  statistics: '统计',
  'machine-learning': '机器学习',
  'meta-composition': '组合与元信号',
  'risk-exits': '风控与离场',
  'sentiment-breadth': '情绪与广度',
  'time-seasonality': '时间与季节性',
  unknown: '其他',
};
const FAMILY_ORDER = Object.keys(FAMILY_LABELS);
const familyRank = (f) => {
  const i = FAMILY_ORDER.indexOf(f);
  return i < 0 ? FAMILY_ORDER.length : i;
};

function listIndicators() {
  if (idxCache) return idxCache;
  const out = [];
  for (const fam of fs.readdirSync(PINE_DIR)) {
    const dir = path.join(PINE_DIR, fam);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.pine')) continue;
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      const m = src.match(/indicator\(\s*(['"])(.*?)\1/);
      out.push({ name: m ? m[2] : f.replace(/\.pine$/, ''), file: `${fam}/${f}`, family: fam });
    }
  }
  out.sort((a, b) => familyRank(a.family) - familyRank(b.family) || a.name.localeCompare(b.name));
  idxCache = out;
  return out;
}

// Fallback catalogue if the live Longbridge list can't be fetched. US-only: this app
// targets Longbridge US equities.
const SYMBOLS = [
  ['AAPL.US', 'Apple Inc.', 'stock'], ['NVDA.US', 'NVIDIA', 'stock'],
  ['MSFT.US', 'Microsoft', 'stock'], ['TSLA.US', 'Tesla', 'stock'],
  ['AMZN.US', 'Amazon', 'stock'], ['GOOGL.US', 'Alphabet', 'stock'],
  ['META.US', 'Meta Platforms', 'stock'], ['SPY.US', 'SPDR S&P 500 ETF', 'stock'],
  ['QQQ.US', 'Invesco QQQ', 'stock'],
];

// The landing order for the symbol picker: the three US index ETFs first, then a set
// of popular names. `section` groups them under a header in the picker.
const RECOMMENDED = [
  ['SPY.US', '指数'], ['QQQ.US', '指数'], ['DIA.US', '指数'],
  ['AAPL.US', '热门股票'], ['NVDA.US', '热门股票'], ['MSFT.US', '热门股票'],
  ['TSLA.US', '热门股票'], ['AMZN.US', '热门股票'], ['GOOGL.US', '热门股票'],
  ['META.US', '热门股票'], ['AVGO.US', '热门股票'], ['AMD.US', '热门股票'],
  ['NFLX.US', '热门股票'], ['GOOG.US', '热门股票'],
];

// The full US symbol universe from Longbridge (`securityList(Market.US)`), cached to
// disk — it changes slowly and the round trip is heavy. Lazy + refreshed once a day.
const US_SYMBOLS_FILE = path.join(CACHE_DIR, 'us-symbols.json');
const US_SYMBOLS_TTL = 24 * 60 * 60_000;
let usSymbolsMem = null;

function orderUsSymbols(rows) {
  const byTicker = new Map(rows.map((r) => [r.ticker, r]));
  const head = [];
  const seen = new Set();
  for (const [ticker, section] of RECOMMENDED) {
    const row = byTicker.get(ticker);
    if (row) { head.push({ ...row, section }); seen.add(ticker); }
  }
  return [...head, ...rows.filter((r) => !seen.has(r.ticker))];
}

async function usSymbols() {
  if (usSymbolsMem) return usSymbolsMem;
  try {
    if (Date.now() - fs.statSync(US_SYMBOLS_FILE).mtimeMs < US_SYMBOLS_TTL) {
      const rows = JSON.parse(fs.readFileSync(US_SYMBOLS_FILE, 'utf8'));
      if (Array.isArray(rows) && rows.length) {
        usSymbolsMem = orderUsSymbols(rows);
        return usSymbolsMem;
      }
    }
  } catch {}
  try {
    const ctx = await getCtx();
    const list = await ctx.securityList(Market.US);
    const rows = list
      .filter((s) => /^[A-Z0-9]+\.US$/.test(s.symbol)) // drop warrants/units/structured (suffixed) tickers
      .map((s) => ({ ticker: s.symbol, description: s.nameEn || s.nameCn || '', type: 'stock' }));
    usSymbolsMem = orderUsSymbols(rows);
    try { fs.writeFileSync(US_SYMBOLS_FILE, JSON.stringify(usSymbolsMem)); } catch {}
    return usSymbolsMem;
  } catch (e) {
    console.warn('securityList failed:', e.message);
    return orderUsSymbols(SYMBOLS.map(([ticker, description, type]) => ({ ticker, description, type })));
  }
}

// ---------------- server ----------------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (u.pathname === '/api/bars') {
      const symbol = u.searchParams.get('symbol') || 'AAPL.US';
      const tf = u.searchParams.get('tf') || '1d';
      if (TF[tf] === undefined) return send(res, 400, JSON.stringify({ error: 'bad tf' }));

      const from = u.searchParams.has('from') ? Number(u.searchParams.get('from')) : null;
      const to = u.searchParams.has('to') ? Number(u.searchParams.get('to')) : null;
      const rawCount = Number(u.searchParams.get('count') || u.searchParams.get('limit') || 500);
      const limit = Math.max(1, Math.min(rawCount || 500, MAX_LIMIT));
      const windowed = from != null || to != null;

      // ---- bounded window (Vela's backfill / request.security range) ----
      if (windowed) {
        let bars = cacheGetWindow(symbol, tf, from, to, limit);
        const coveredFrom = cacheCoveredFrom(symbol, tf);
        const covered =
          to != null &&
          (bars.length >= limit ||
            coveredFrom === 0 ||
            (coveredFrom != null && from != null && coveredFrom <= from));
        let source = 'cache';
        if (!covered) {
          try {
            const { bars: fetched, hitGenesis } = await fetchWindow(symbol, tf, from, to, limit);
            if (fetched.length || hitGenesis) cachePut(symbol, tf, fetched, { hitGenesis });
            bars = cacheGetWindow(symbol, tf, from, to, limit);
            source = 'longbridge';
          } catch (e) {
            if (bars.length === 0) throw e;
            source = 'cache(stale)';
          }
        }
        return send(res, 200, JSON.stringify({ symbol, tf, source, bars }));
      }

      // ---- latest N (initial load / live polling) ----
      const cachedN = cacheCount(symbol, tf);
      const fresh = Date.now() - cacheFetchedAt(symbol, tf) < ttlOf(tf);
      let source = 'cache';
      if (!(fresh && cachedN >= limit)) {
        try {
          const { bars: fetched, hitGenesis } = await fetchWindow(symbol, tf, null, null, limit);
          if (fetched.length) cachePut(symbol, tf, fetched, { hitGenesis });
          source = 'longbridge';
        } catch (e) {
          if (cachedN === 0) throw e;
          source = 'cache(stale)';
        }
      }
      return send(res, 200, JSON.stringify({ symbol, tf, source, bars: cacheGet(symbol, tf, limit) }));
    }

    if (u.pathname === '/api/symbols') {
      return send(res, 200, JSON.stringify(await usSymbols()));
    }

    if (u.pathname === '/api/indicators.json') {
      return send(res, 200, JSON.stringify(listIndicators().map((it) => ({
        name: it.name,
        url: `/api/indicators/raw?file=${encodeURIComponent(it.file)}`,
        language: 'pine',
        enabled: false,
        category: FAMILY_LABELS[it.family] ?? it.family,
      }))));
    }

    if (u.pathname === '/api/indicators') {
      return send(res, 200, JSON.stringify(listIndicators()));
    }

    if (u.pathname === '/api/indicators/raw') {
      const file = u.searchParams.get('file') || '';
      const full = path.join(PINE_DIR, file);
      if (!full.startsWith(PINE_DIR) || !fs.existsSync(full)) return send(res, 404, 'not found', 'text/plain');
      return send(res, 200, fs.readFileSync(full), 'text/plain; charset=utf-8');
    }

    if (fs.existsSync(DIST)) {
      const rel = decodeURIComponent(u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
      let file = path.join(DIST, rel);
      if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(DIST, 'index.html');
      }
      const MIME = {
        '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
        '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
        '.woff2': 'font/woff2', '.png': 'image/png',
      };
      return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
    }

    return send(res, 404, JSON.stringify({ error: 'not found' }));
  } catch (e) {
    return send(res, 500, JSON.stringify({ error: e.message }));
  }
});

const PORT = process.env.API_PORT || 5174;
server.listen(PORT, () => console.log(`api on http://localhost:${PORT}`));

fetchWindow('AAPL.US', '1d', null, null, 2)
  .then(() => console.log('longbridge warm-up ok'))
  .catch((e) => console.warn('longbridge warm-up failed:', e.message));

// Pre-fetch the US symbol universe so the picker's first open is instant.
usSymbols()
  .then((rows) => console.log(`symbol universe ready: ${rows.length} US symbols`))
  .catch((e) => console.warn('symbol universe failed:', e.message));
