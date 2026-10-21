import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { ServerResponse } from 'node:http';
import { DEFAULT_PORT } from './server/config.ts';
import { AppError, ERROR_CODES, badRequest, methodNotAllowed, notFound } from './server/errors.ts';
import { logger } from './server/logger.ts';
import { docsHtml, openapi } from './server/openapi.ts';
import { paginate, readJsonBody, send, stripApiPrefix } from './server/http.ts';
import { oneOf, parsePagination, parseInteger, requireString, resolveWithin, usSymbol } from './server/validate.ts';
import {
  cacheCount,
  cacheCoveredFrom,
  cacheFetchedAt,
  cacheGet,
  cacheGetWindow,
  cachePut,
  closeDb,
} from './server/db.ts';
import {
  type Timeframe,
  buildTradingDayPlan,
  inferSessionCloseFromBars,
  sessionDateInZone,
  timeframeMs,
  runBacktest,
  createLlmBacktestAgent,
  createOpenAiCompatibleClient,
} from '@vela/trading-core';

type Bar = { time: number; open: number; high: number; low: number; close: number; volume?: number | null };
type SymbolRow = { ticker: string; description?: string; type?: string; section?: string };
type IndicatorEntry = { name: string; file: string; family: string };
type CustomScript = { id: string; name: string; script: string; createdAt?: number; updatedAt?: number };
type AgentConfig = { key: string; source: 'env' | 'file' | null; base: string; model: string; effort: 'low' | 'high' | 'max' };
type AgentFile = { apiKey?: string; baseURL?: string; model?: string; reasoningEffort?: string };
type StreamEntry = { symbol: string; tf: string; period: unknown; clients: Set<ServerResponse>; subscribed: boolean };
type RunState = { runId: string; paused: boolean; stopped: boolean };
type BacktestRun = { pause: () => void; resume: () => void; stop: () => void; state: () => RunState };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  /* .env is optional */
}
const PINE_DIR = path.join(ROOT, 'data', 'pine');
const DIST = path.join(__dirname, 'dist');
const CACHE_DIR = path.join(ROOT, 'data', 'cache');

// --- Longbridge: force the international gateway ---
process.env.LONGPORT_HTTP_URL ||= 'https://openapi.longportapp.com';
process.env.LONGPORT_QUOTE_WS_URL ||= 'wss://openapi-quote.longportapp.com/v2';
process.env.LONGPORT_TRADE_WS_URL ||= 'wss://openapi-trade.longportapp.com/v2';
process.env.LONGPORT_PUSH_CANDLESTICK_MODE ||= 'realtime';

// Intraday analysis agent (DeepSeek V4.1 Flash, OpenAI-compatible API). The key comes
// from the environment first, then from a local, git-ignored data/agent.json:
//   { "apiKey": "...", "baseURL": "...", "model": "deepseek-flash", "reasoningEffort": "low" }
// V4.1 Flash (`deepseek-flash`) is natively multimodal, so screenshots go straight into
// the user message's `content` parts; no separate vision endpoint is needed.
function loadAgentConfig(): AgentConfig {
  let file: AgentFile = {};
  try {
    file = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'agent.json'), 'utf8')) as AgentFile;
  } catch {
    /* no local config */
  }
  const envKey = process.env.DEEPSEEK_API_KEY || '';
  const effortRaw = process.env.AGENT_REASONING_EFFORT || file.reasoningEffort || 'low';
  const effort = effortRaw === 'high' || effortRaw === 'max' ? effortRaw : 'low';
  return {
    key: envKey || file.apiKey || '',
    source: envKey ? ('env' as const) : file.apiKey ? ('file' as const) : null,
    base: (process.env.DEEPSEEK_BASE_URL || file.baseURL || 'https://api.deepseek.com').replace(/\/+$/, ''),
    model: process.env.DEEPSEEK_MODEL || file.model || 'deepseek-flash',
    effort,
  };
}

function startOfTodayMs(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const localAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  const offset = localAsUtc - Math.floor(ms / 1000) * 1000;
  return Date.UTC(get('year'), get('month') - 1, get('day')) - offset;
}

function todayLabel(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

function clockLabel(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
}

async function todayBars(symbol: string, tf: string): Promise<Bar[]> {
  const tz = tzForSymbol(symbol);
  const to = Date.now();
  const from = startOfTodayMs(to, tz);
  try {
    const { bars } = await fetchWindow(symbol, tf, from, to, 2000);
    return bars.filter((bar: Bar) => bar.time >= from && bar.time <= to);
  } catch (e) {
    logger.warn('[agent] today bars failed:', (e as Error).message);
    return [];
  }
}

async function buildAgentPrompt(body: Record<string, any>, hasImages = false): Promise<string> {
  const symbol = typeof body.symbol === 'string' ? body.symbol : '';
  const ticker = symbol.split(':').pop();
  const timeframe = agentTfLabel(typeof body.timeframe === 'string' ? body.timeframe : '');
  const context = body.context && typeof body.context === 'object' ? body.context : {};
  const tz = ticker ? tzForSymbol(ticker) : 'UTC';
  const now = Date.now();
  const bars = ticker ? await todayBars(ticker, agentTfLabel(body.timeframe)) : [];
  const shown = bars.slice(-500);
  const lines = shown.map((bar) => `${clockLabel(bar.time, tz)} ${bar.open} ${bar.high} ${bar.low} ${bar.close} ${bar.volume ?? 0}`);
  return [
    '你是桌面图表应用中的日内交易分析助手。刚刚有一根 K 线收盘，请根据最新结构为交易者做分析。',
    `标的：${symbol || '未知'} ｜ 周期：${timeframe} ｜ 市场时区：${tz}`,
    `交易日：${todayLabel(now, tz)} ｜ 当前时间：${clockLabel(now, tz)}（${new Date(now).toISOString()}）`,
    `客户端上下文：${JSON.stringify(context).slice(0, 1500)}`,
    `当日 K 线（共 ${shown.length} 根，按时间从旧到新；列依次为：时间 开盘 最高 最低 收盘 成交量）：`,
    ...lines,
    hasImages
      ? '已附当前图表截图。请结合 K 线数据，解读截图中的 SMC 标记（BOS/CHoCH、订单块、FVG、等高/等低）。'
      : '未附截图。请只依据 K 线数据和客户端上下文分析。',
    '请用简体中文回答。先说这根收盘 K 线带来了什么变化，再给出倾向、关键价位、触发条件、失效条件和风险。',
    '所有价位必须来自给定数据或明确说明的假设，禁止编造价格、新闻或指标数值。',
    '保持简洁：每次收盘都会运行，不要重复整段历史。',
    '这是分析辅助，不是确定性预测，也不构成投资建议；不涉及下单执行。',
  ].join('\n');
}

const { Config, QuoteContext, Period, AdjustType, TradeSessions, NaiveDate, NaiveDatetime, Time, Market } =
  await import('longport');

const TF: Record<string, any> = {
  '1m': Period.Min_1, '5m': Period.Min_5, '15m': Period.Min_15, '30m': Period.Min_30,
  '1h': Period.Min_60, '2h': Period.Min_120, '4h': Period.Min_240,
  '1d': Period.Day, '1w': Period.Week, '1M': Period.Month,
};

// Chart UI values ('5', '60', 'D') -> the labels the agent prompt and UI speak.
const AGENT_TF_LABEL: Record<string, string> = {
  '1': '1m', '5': '5m', '15': '15m', '30': '30m', '60': '1h', '120': '2h', '240': '4h',
  D: '1d', W: '1w', M: '1M',
};
function agentTfLabel(tf: string): string {
  return AGENT_TF_LABEL[tf] || tf || 'unknown';
}

// Longbridge caps a single candlestick request at 1000 bars — deeper windows page.
const PAGE = 1000;
// Hard ceiling for one HTTP request from the client (Vela backfills in ~10000-bar chunks).
const MAX_LIMIT = 50000;

// Longbridge history anchors are NAIVE datetimes interpreted in the MARKET's timezone.
const TZ_BY_SUFFIX: Array<[string, string]> = [
  ['.US', 'America/New_York'], ['.HK', 'Asia/Hong_Kong'],
  ['.SH', 'Asia/Shanghai'], ['.SZ', 'Asia/Shanghai'],
];
function tzForSymbol(symbol: string): string {
  const hit = TZ_BY_SUFFIX.find(([s]) => symbol.endsWith(s));
  return hit ? hit[1] : 'UTC';
}
function toNaiveDatetime(ms: number, tz: string): any {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date(ms));
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return new NaiveDatetime(new NaiveDate(g('year'), g('month'), g('day')), new Time(g('hour') % 24, g('minute'), g('second')));
}

const ttlOf = (tf: string): number => (/[hm]$/.test(tf) ? 60_000 : 30 * 60_000);

// ---------------- Longbridge client ----------------
let ctxPromise: any = null;
function getCtx(): any {
  if (!ctxPromise) {
    const config = Config.fromApikey(
      process.env.LONGPORT_APP_KEY ?? '',
      process.env.LONGPORT_APP_SECRET ?? '',
      process.env.LONGPORT_ACCESS_TOKEN ?? '',
    );
    const ctx = QuoteContext.new(config);
    bindCandlestickPush(ctx);
    ctxPromise = ctx;
  }
  return ctxPromise;
}

// ---------------- realtime candlestick push (SSE) ----------------
// The SDK pushes through one socket owned by the QuoteContext, so subscriptions are
// reference-counted per (symbol, timeframe) and fanned out to every connected client.
const PERIOD_TF = new Map<unknown, string>(Object.entries(TF).map(([tf, period]) => [period, tf]));
const streams = new Map<string, StreamEntry>(); // `${symbol}|${tf}` -> { symbol, tf, period, clients:Set, subscribed }
const backtestRuns = new Map<string, BacktestRun>();
let pushBound = false;

function sendFrame(client: ServerResponse, payload: string): void {
  if (client.destroyed || client.writableEnded) return;
  try {
    client.write(payload);
  } catch {
    /* the client disconnected between the check and the write */
  }
}

function bindCandlestickPush(ctx: any): void {
  if (pushBound) return;
  pushBound = true;
  ctx.setOnCandlestick((err: any, event: any) => {
    try {
      if (err) {
        logger.warn('[push] candlestick error:', err.message);
        return;
      }
      const tf = PERIOD_TF.get(event.data.period);
      if (!tf) return;
      const entry = streams.get(`${event.symbol}|${tf}`);
      if (!entry) return;
      const bar = toBar(event.data.candlestick);
      const payload = `data: ${JSON.stringify({ symbol: event.symbol, tf, confirmed: event.data.isConfirmed, bar })}\n\n`;
      for (const client of entry.clients) sendFrame(client, payload);
      // Only the closed bar is worth persisting; the forming candle is pushed many times
      // per second and the history endpoint answers it anyway.
      if (event.data.isConfirmed) cachePut(event.symbol, tf, [bar], {});
    } catch (e) {
      logger.warn('[push] frame failed:', (e as Error).message);
    }
  });
}

async function subscribeStream(entry: StreamEntry): Promise<void> {
  if (entry.subscribed) return;
  const ctx = await getCtx();
  await ctx.subscribeCandlesticks(entry.symbol, entry.period, TradeSessions.Intraday);
  entry.subscribed = true;
}

async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let lastErr: unknown;
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

function toBar(b: any): Bar {
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
async function fetchWindow(symbol: string, tf: string, from: number | null, to: number | null, limit: number): Promise<{ bars: Bar[]; hitGenesis: boolean }> {
  const period = TF[tf];
  const tz = tzForSymbol(symbol);
  const ctx = await getCtx();
  const byTime = new Map<number, Bar>();
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
      batch = await withRetry<any>(() =>
        ctx.historyCandlesticksByOffset(symbol, period, AdjustType.NoAdjust, false, anchorDt, want, TradeSessions.Intraday),
      );
    } catch (e) {
      // Longbridge refuses anchors before the venue's history floor (e.g. minute bars
      // begin 2023-10-01) with a "limit" error. If we had already walked down to it that
      // IS the bottom (genesis); an anchor BEYOND the floor that we never reached proves
      // nothing — just return what we have.
      const msg = String((e as Error)?.message || e);
      if (byTime.size > 0) hitGenesis = true;
      else if (!/limit|301600|301607/i.test(msg)) throw e;
      break;
    }
    if (!batch || batch.length === 0) {
      if (byTime.size > 0) hitGenesis = true;
      break;
    }
    let oldestNew = Infinity; // oldest bar STRICTLY older than the anchor = real progress
    for (const b of batch as any[]) {
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
let idxCache: IndicatorEntry[] | null = null;
// Indicator folders → picker group labels, in display order. The picker groups the
// catalogue by `category`, so this is both the label and the ordering.
const FAMILY_LABELS: Record<string, string> = {
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
const familyRank = (f: string): number => {
  const i = FAMILY_ORDER.indexOf(f);
  return i < 0 ? FAMILY_ORDER.length : i;
};

function listIndicators(): IndicatorEntry[] {
  if (idxCache) return idxCache;
  const out: IndicatorEntry[] = [];
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
  out.sort((a: IndicatorEntry, b: IndicatorEntry) => familyRank(a.family) - familyRank(b.family) || a.name.localeCompare(b.name));
  idxCache = out;
  return out;
}

// ---------------- user scripts (custom indicators) ----------------
const CUSTOM_FILE = path.join(ROOT, 'data', 'custom-indicators.json');

function loadCustom(): CustomScript[] {
  try {
    const rows = JSON.parse(fs.readFileSync(CUSTOM_FILE, 'utf8'));
    return Array.isArray(rows) ? (rows as CustomScript[]) : [];
  } catch {
    return [];
  }
}
function saveCustom(rows: CustomScript[]): void {
  fs.mkdirSync(path.dirname(CUSTOM_FILE), { recursive: true });
  fs.writeFileSync(CUSTOM_FILE, JSON.stringify(rows, null, 2));
}
function slugId(name: string): string {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'script';
  return `${base}-${Date.now().toString(36)}`;
}

// Fallback catalogue if the live Longbridge list can't be fetched. US-only: this app
// targets Longbridge US equities.
const SYMBOLS: Array<[string, string, string]> = [
  ['AAPL.US', 'Apple Inc.', 'stock'], ['NVDA.US', 'NVIDIA', 'stock'],
  ['MSFT.US', 'Microsoft', 'stock'], ['TSLA.US', 'Tesla', 'stock'],
  ['AMZN.US', 'Amazon', 'stock'], ['GOOGL.US', 'Alphabet', 'stock'],
  ['META.US', 'Meta Platforms', 'stock'], ['SPY.US', 'SPDR S&P 500 ETF', 'stock'],
  ['QQQ.US', 'Invesco QQQ', 'stock'],
];

// The landing order for the symbol picker: the three US index ETFs first, then a set
// of popular names. `section` groups them under a header in the picker.
const RECOMMENDED: Array<[string, string]> = [
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
let usSymbolsMem: SymbolRow[] | null = null;

function orderUsSymbols(rows: SymbolRow[]): SymbolRow[] {
  const byTicker = new Map(rows.map((r) => [r.ticker, r]));
  const head: SymbolRow[] = [];
  const seen = new Set<string>();
  for (const [ticker, section] of RECOMMENDED) {
    const row = byTicker.get(ticker);
    if (row) { head.push({ ...row, section }); seen.add(ticker); }
  }
  return [...head, ...rows.filter((r) => !seen.has(r.ticker))];
}

async function usSymbols(): Promise<SymbolRow[]> {
  if (usSymbolsMem) return usSymbolsMem;
  try {
    if (Date.now() - fs.statSync(US_SYMBOLS_FILE).mtimeMs < US_SYMBOLS_TTL) {
      const rows = JSON.parse(fs.readFileSync(US_SYMBOLS_FILE, 'utf8')) as SymbolRow[];
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
      .filter((s: any) => /^[A-Z0-9]+\.US$/.test(s.symbol)) // drop warrants/units/structured (suffixed) tickers
      .map((s: any) => ({ ticker: s.symbol, description: s.nameEn || s.nameCn || '', type: 'stock' }));
    usSymbolsMem = orderUsSymbols(rows);
    try { fs.writeFileSync(US_SYMBOLS_FILE, JSON.stringify(usSymbolsMem)); } catch {}
    return usSymbolsMem;
  } catch (e) {
    logger.warn('securityList failed:', (e as Error).message);
    return orderUsSymbols(SYMBOLS.map(([ticker, description, type]) => ({ ticker, description, type })));
  }
}

// ---------------- server ----------------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url ?? '/', 'http://localhost');
  const pathname = stripApiPrefix(u.pathname);
  const startedAt = Date.now();
  res.on('finish', () => {
    logger.info('http', { method: req.method, path: u.pathname, status: res.statusCode, ms: Date.now() - startedAt });
  });
  try {
    if (pathname === '/api/openapi.json') {
      return send(res, 200, JSON.stringify(openapi));
    }

    if (pathname === '/api/docs') {
      return send(res, 200, docsHtml, 'text/html; charset=utf-8');
    }

    if (pathname === '/api/health') {
      return send(res, 200, JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    }

    if (pathname === '/api/stream') {
      const symbol = usSymbol(u.searchParams.get('symbol'));
      const tf = oneOf(u.searchParams.get('tf'), Object.keys(TF), 'tf');
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'access-control-allow-origin': '*',
      });
      res.on('error', () => {}); // a client dropping mid-frame must not take the service down
      sendFrame(res, ': connected\n\n');
      const key = `${symbol}|${tf}`;
      let entry = streams.get(key);
      if (!entry) {
        entry = { symbol, tf, period: TF[tf], clients: new Set(), subscribed: false };
        streams.set(key, entry);
      }
      entry.clients.add(res);
      const heartbeat = setInterval(() => sendFrame(res, ': ping\n\n'), 15_000);
      subscribeStream(entry).catch((e) => {
        logger.warn(`[push] subscribe failed ${symbol} ${tf}:`, e.message);
        sendFrame(res, `event: stream-error\ndata: ${JSON.stringify({ message: e.message })}\n\n`);
      });
      req.on('close', () => {
        clearInterval(heartbeat);
        entry.clients.delete(res);
        if (entry.clients.size > 0) return;
        streams.delete(key);
        if (!entry.subscribed) return;
        void (async () => {
          try {
            const ctx = await getCtx();
            await ctx.unsubscribeCandlesticks(entry.symbol, entry.period);
          } catch {
            /* the socket is already gone */
          }
        })();
      });
      return;
    }

    if (pathname === '/api/agent/status') {
      const agent = loadAgentConfig();
      return send(res, 200, JSON.stringify({
        configured: Boolean(agent.key),
        source: agent.source,
        model: agent.model,
        effort: agent.effort,
      }));
    }

    // The system prompt for the current chart, so the panel can show it before the
    // first candle closes.
    if (pathname === '/api/agent/system') {
      const agent = loadAgentConfig();
      const symbol = u.searchParams.get('symbol') || '';
      const timeframe = u.searchParams.get('timeframe') || '';
      const content = await buildAgentPrompt({ symbol, timeframe, context: {} }, false);
      return send(res, 200, JSON.stringify({
        content,
        meta: {
          symbol,
          timeframe: agentTfLabel(timeframe),
          model: agent.model,
          effort: agent.effort,
          vision: false,
          images: 0,
        },
      }));
    }

    // Intraday analysis agent. The DeepSeek key never reaches the renderer: the server
    // calls the OpenAI-compatible endpoint and relays reasoning/content deltas as SSE.
    if (pathname === '/api/agent') {
      if (req.method !== 'POST') return send(res, 405, JSON.stringify({ error: 'method not allowed' }));
      const agent = loadAgentConfig();
      if (!agent.key) {
        return send(res, 503, JSON.stringify({
          error: '未检测到 DEEPSEEK_API_KEY，请设置环境变量后重启应用（或在 data/agent.json 中配置 apiKey）',
        }));
      }
      const body = await readJsonBody(req, 8_000_000);
      const messages = Array.isArray(body.messages)
        ? body.messages
            .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
            .slice(-20)
            .map((m) => ({ role: m.role, content: m.content }))
        : [];
      const images = Array.isArray(body.images) ? body.images.filter((img) => img && img.data).slice(0, 2) : [];
      body.images = images;
      const system = await buildAgentPrompt(body, images.length > 0);
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'access-control-allow-origin': '*',
      });
      res.on('error', () => {});
      sendFrame(res, `data: ${JSON.stringify({
        type: 'system',
        content: system,
        meta: {
          symbol: body.symbol,
          timeframe: agentTfLabel(body.timeframe),
          model: agent.model,
          effort: agent.effort,
          vision: images.length > 0,
          images: images.length,
        },
      })}\n\n`);
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      try {
        let upstreamMessages = [{ role: 'system', content: system }, ...messages];
        if (images.length > 0) {
          const lastUser = [...upstreamMessages].reverse().find((m) => m.role === 'user');
          if (lastUser) {
            upstreamMessages = upstreamMessages.map((m) =>
              m === lastUser
                ? {
                    role: 'user',
                    content: [
                      { type: 'text', text: m.content },
                      ...images.map((img) => ({
                        type: 'image_url',
                        image_url: { url: `data:${img.mime || 'image/jpeg'};base64,${img.data}` },
                      })),
                    ],
                  }
                : m,
            );
          }
        }
        const upstream = await fetch(`${agent.base}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${agent.key}`,
          },
          body: JSON.stringify({
            model: agent.model,
            reasoning_effort: agent.effort,
            stream: true,
            messages: upstreamMessages,
          }),
          signal: abort.signal,
        });
        if (!upstream.ok) {
          const detail = (await upstream.text()).slice(0, 500);
          sendFrame(res, `data: ${JSON.stringify({ type: 'error', message: `DeepSeek ${upstream.status}: ${detail}` })}\n\n`);
          return res.end();
        }
        if (!upstream.body) return res.end();
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let cut;
          while ((cut = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, cut).trim();
            buffer = buffer.slice(cut + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data) continue;
            if (data === '[DONE]') {
              sendFrame(res, `data: ${JSON.stringify({ type: 'done' })}\n\n`);
              return res.end();
            }
            let parsed;
            try {
              parsed = JSON.parse(data);
            } catch {
              continue;
            }
            const delta = parsed.choices?.[0]?.delta;
            if (!delta) continue;
            if (delta.reasoning_content) {
              sendFrame(res, `data: ${JSON.stringify({ type: 'reasoning', delta: delta.reasoning_content })}\n\n`);
            }
            if (delta.content) {
              sendFrame(res, `data: ${JSON.stringify({ type: 'content', delta: delta.content })}\n\n`);
            }
          }
        }
        sendFrame(res, `data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.end();
      } catch (e) {
        if (!abort.signal.aborted) {
          sendFrame(res, `data: ${JSON.stringify({ type: 'error', message: (e as Error).message })}\n\n`);
          res.end();
        }
      }
      return;
    }

    if (pathname === '/api/backtest/session') {
      try {
        const symbol = usSymbol(u.searchParams.get('symbol'));
        const date = requireString(u.searchParams.get('date'), 'date', { maxLength: 10 });
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('date must be YYYY-MM-DD');
        const timeframe = oneOf(u.searchParams.get('timeframe') || '5m', Object.keys(TF), 'timeframe') as Timeframe;
        const tfMs = timeframeMs(timeframe);
        const base = buildTradingDayPlan({ date, timeframe });
        if (!base.isTradingDay) throw new Error(`${date} is not a US trading day`);
        const today = sessionDateInZone(Date.now(), 'America/New_York');
        if (date > today) throw new Error('Backtest date is in the future');
        if (date === today && Date.now() < base.close) throw new Error('Today\'s session is not finished yet');
        const from = base.open - 7 * 86_400_000;
        const { bars, hitGenesis } = await fetchWindow(symbol, timeframe, from, base.close, 10_000);
        const coreBars = bars.map((bar) => ({
          symbol,
          timeframe,
          openTime: bar.time,
          closeTime: bar.time + tfMs,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume ?? 0,
        }));
        const earlyClose = inferSessionCloseFromBars(coreBars, base);
        const plan = earlyClose ? buildTradingDayPlan({ date, timeframe, close: earlyClose }) : base;
        const sessionBars = coreBars.filter(
          (bar) => bar.closeTime > plan.open && bar.closeTime <= plan.close,
        );
        return send(res, 200, JSON.stringify({
          symbol,
          date,
          timeframe,
          plan,
          isEarlyClose: plan.isEarlyClose,
          sessionBars: sessionBars.length,
          warmupBars: coreBars.length - sessionBars.length,
          hitGenesis,
        }));
      } catch (e) {
        return send(res, 400, JSON.stringify({ error: (e as Error).message }));
      }
    }

    if (pathname === '/api/backtest/control') {
      if (req.method !== 'POST') throw methodNotAllowed();
      const body = await readJsonBody(req, 20_000);
      const runId = requireString(body.runId, 'runId', { maxLength: 64 });
      const run = backtestRuns.get(runId);
      if (!run) throw notFound('run not found or already finished');
      const action = oneOf(body.action, ['pause', 'resume', 'stop'], 'action');
      if (action === 'pause') run.pause();
      else if (action === 'resume') run.resume();
      else run.stop();
      return send(res, 200, JSON.stringify({ ok: true, ...run.state() }));
    }

    if (pathname === '/api/backtest/run') {
      if (req.method !== 'POST') throw methodNotAllowed();
      const agent = loadAgentConfig();
      if (!agent.key) {
        return send(res, 503, JSON.stringify({
          error: '未检测到 DEEPSEEK_API_KEY，无法运行 AI 回测',
        }));
      }
      const body = await readJsonBody(req, 200_000);
      const symbol = usSymbol(body.symbol);
      const date = requireString(body.date, 'date', { maxLength: 10 });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('date must be YYYY-MM-DD');
      const timeframe = oneOf(body.timeframe || '5m', Object.keys(TF), 'timeframe') as Timeframe;
      const positionSizePct = parseInteger(body.positionSizePct, 'positionSizePct', { min: 1, max: 100, fallback: 80 });
      const maxEntriesPerDay = parseInteger(body.maxEntriesPerDay, 'maxEntriesPerDay', { min: 1, max: 50, fallback: 2 });
      const allowShort = body.allowShort !== false;
      const allowAddOn = body.allowAddOn === true;
      const initialCapital = parseInteger(body.initialCapital, 'initialCapital', { min: 1, max: 1_000_000_000, fallback: 100_000 });
      const slippageBps = parseInteger(body.slippageBps, 'slippageBps', { min: 0, max: 1000, fallback: 2 });
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'access-control-allow-origin': '*',
      });
      const emit = (event: unknown) => sendFrame(res, `data: ${JSON.stringify(event)}\n\n`);
      const abort = new AbortController();
      const stopAbort = new AbortController();
      res.on('error', () => {});
      res.on('close', () => abort.abort());
      const runId = randomUUID();
      const pauseState: { paused: boolean; waiters: Array<() => void> } = { paused: false, waiters: [] };
      const waitIfPaused = (): Promise<void> => {
        if (!pauseState.paused) return Promise.resolve();
        return new Promise<void>((resolve) => {
          const release = () => {
            abort.signal.removeEventListener('abort', release);
            stopAbort.signal.removeEventListener('abort', release);
            resolve();
          };
          abort.signal.addEventListener('abort', release, { once: true });
          stopAbort.signal.addEventListener('abort', release, { once: true });
          pauseState.waiters.push(release);
        });
      };
      const runControl = {
        pause() {
          if (pauseState.paused) return;
          pauseState.paused = true;
          emit({ type: 'control', action: 'pause' });
        },
        resume() {
          if (!pauseState.paused) return;
          pauseState.paused = false;
          const waiters = pauseState.waiters.splice(0);
          for (const release of waiters) release();
          emit({ type: 'control', action: 'resume' });
        },
        stop() {
          if (stopAbort.signal.aborted) return;
          stopAbort.abort();
          const waiters = pauseState.waiters.splice(0);
          for (const release of waiters) release();
          emit({ type: 'control', action: 'stop' });
        },
        state() {
          return { runId, paused: pauseState.paused, stopped: stopAbort.signal.aborted };
        },
      };
      backtestRuns.set(runId, runControl);
      logger.info(`[backtest] run ${runId} ${symbol} ${date} ${timeframe}`);
      emit({ type: 'run', runId });
      try {
        const tfMs = timeframeMs(timeframe);
        const base = buildTradingDayPlan({ date, timeframe });
        if (!base.isTradingDay) throw new Error(`${date} is not a US trading day`);
        const today = sessionDateInZone(Date.now(), 'America/New_York');
        if (date > today) throw new Error('Backtest date is in the future');
        if (date === today && Date.now() < base.close) throw new Error('Today\'s session is not finished yet');
        emit({ type: 'session', phase: 'loading', plan: base });
        const from = base.open - 7 * 86_400_000;
        const { bars } = await fetchWindow(symbol, timeframe, from, base.close, 10_000);
        const coreBars = bars.map((bar) => ({
          symbol,
          timeframe,
          openTime: bar.time,
          closeTime: bar.time + tfMs,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume ?? 0,
        }));
        const earlyClose = inferSessionCloseFromBars(coreBars, base);
        const session = earlyClose ? buildTradingDayPlan({ date, timeframe, close: earlyClose }) : base;
        emit({ type: 'session', phase: 'ready', plan: session, bars: coreBars.length });
        const client = createOpenAiCompatibleClient({ baseURL: agent.base, apiKey: agent.key });
        const llmSignal = AbortSignal.any([abort.signal, stopAbort.signal]);
        const inner = createLlmBacktestAgent({
          client,
          model: agent.model,
          reasoningEffort: agent.effort,
          signal: llmSignal,
          onEvent: (event) => {
            if (event.type === 'error') logger.warn('[backtest] agent error:', event.message);
            else if (event.type === 'tool_result' && !event.result.ok) {
              logger.warn('[backtest] tool rejected:', event.name, event.result.error?.code, event.result.error?.message);
            }
            emit({ type: 'agent', event });
          },
        });
        const wrapped = {
          async decide(input: any): Promise<any> {
            emit({ type: 'decision', asOf: input.asOf, entryQuota: input.entryQuota, position: input.position });
            return inner.decide(input);
          },
        };
        const report = await runBacktest({
          config: {
            symbol,
            date,
            timeframe,
            initialCapital,
            positionSizePct,
            maxEntriesPerDay,
            allowShort,
            allowAddOn,
            slippageBps,
          },
          session: earlyClose ? { close: earlyClose } : {},
          bars: coreBars,
          agent: wrapped,
          signal: abort.signal,
          stopSignal: stopAbort.signal,
          waitIfPaused,
        });
        logger.info(`[backtest] done ${runId}${report.stopped ? ' (stopped)' : ''} entries=${report.metrics.entriesUsed} pnl=${report.metrics.netPnl.toFixed(2)}`);
        emit({
          type: 'done',
          report: {
            session: report.session,
            metrics: report.metrics,
            orders: report.orders,
            fills: report.fills,
            closedTrades: report.closedTrades,
            equityCurve: report.equityCurve,
            blockedOrders: report.blockedOrders,
            decisions: report.decisions.length,
            finalAccount: report.finalAccount,
            stopped: report.stopped,
            ...(report.stoppedAt != null ? { stoppedAt: report.stoppedAt } : {}),
          },
        });
        res.end();
      } catch (e) {
        if (!abort.signal.aborted) {
          logger.warn(`[backtest] failed ${runId}:`, (e as Error).message);
          emit({ type: 'error', message: (e as Error).message });
        }
        res.end();
      } finally {
        backtestRuns.delete(runId);
      }
      return;
    }

    if (pathname === '/api/bars') {
      const symbol = usSymbol(u.searchParams.get('symbol') || 'AAPL.US');
      const tf = oneOf(u.searchParams.get('tf') || '1d', Object.keys(TF), 'tf');
      const from = u.searchParams.has('from')
        ? parseInteger(u.searchParams.get('from'), 'from', { min: 0 })
        : null;
      const to = u.searchParams.has('to')
        ? parseInteger(u.searchParams.get('to'), 'to', { min: 0 })
        : null;
      const limit = parseInteger(
        u.searchParams.get('count') || u.searchParams.get('limit'),
        'count',
        { min: 1, max: MAX_LIMIT, fallback: 500 },
      );
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

    if (pathname === '/api/symbols') {
      const pagination = parsePagination(u.searchParams);
      return send(res, 200, JSON.stringify(paginate(await usSymbols(), pagination)));
    }

    if (pathname === '/api/indicators.json') {
      const builtins = listIndicators().map((it) => ({
        name: it.name,
        url: `/api/v1/indicators/raw?file=${encodeURIComponent(it.file)}`,
        language: 'pine',
        enabled: false,
        category: FAMILY_LABELS[it.family] ?? it.family,
      }));
      // User scripts ride the same manifest, under a dedicated, editable category.
      const customs = loadCustom().map((s) => ({
        name: s.name,
        script: s.script,
        language: 'pine',
        enabled: false,
        category: '我的脚本',
        editable: true,
        id: s.id,
      }));
      return send(res, 200, JSON.stringify([...customs, ...builtins]));
    }

    if (pathname === '/api/custom-indicators') {
      if (req.method === 'GET') {
        const pagination = parsePagination(u.searchParams);
        return send(res, 200, JSON.stringify(paginate(loadCustom(), pagination)));
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const name = requireString(body.name, 'name', { maxLength: 80 });
        const script = requireString(body.script, 'script', { maxLength: 200_000 });
        const rows = loadCustom();
        const existing = body.id ? rows.find((r) => r.id === body.id) : null;
        if (existing) {
          existing.name = name;
          existing.script = script;
          existing.updatedAt = Date.now();
        } else {
          rows.push({ id: slugId(name), name, script, createdAt: Date.now() });
        }
        saveCustom(rows);
        return send(res, 200, JSON.stringify(existing ?? rows[rows.length - 1]));
      }
      if (req.method === 'DELETE') {
        const id = requireString(u.searchParams.get('id'), 'id', { maxLength: 80 });
        saveCustom(loadCustom().filter((r) => r.id !== id));
        return send(res, 200, JSON.stringify({ ok: true }));
      }
      throw methodNotAllowed();
    }

    if (pathname === '/api/indicators') {
      const pagination = parsePagination(u.searchParams);
      return send(res, 200, JSON.stringify(paginate(listIndicators(), pagination)));
    }

    // Overwrite a bundled (vault) indicator's source in place — the "edit any indicator"
    // path from the chart legend. Matched by declared name.
    if (pathname === '/api/indicators/source' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const name = requireString(body.name, 'name', { maxLength: 120 });
      const script = requireString(body.script, 'script', { maxLength: 200_000 });
      const item = listIndicators().find((it) => it.name === name);
      if (!item) return send(res, 404, JSON.stringify({ error: 'indicator not found' }));
      const full = resolveWithin(PINE_DIR, item.file);
      fs.writeFileSync(full, script);
      idxCache = null;
      return send(res, 200, JSON.stringify({ ok: true, file: item.file }));
    }

    if (pathname === '/api/indicators/raw') {
      const file = u.searchParams.get('file') || '';
      let full;
      try {
        full = resolveWithin(PINE_DIR, file);
      } catch {
        return send(res, 404, 'not found', 'text/plain');
      }
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return send(res, 404, 'not found', 'text/plain');
      return send(res, 200, fs.readFileSync(full), 'text/plain; charset=utf-8');
    }

    if (u.pathname.startsWith('/api/')) throw notFound();

    if (fs.existsSync(DIST)) {
      const rel = decodeURIComponent(pathname === '/' ? 'index.html' : pathname.slice(1));
      let file = path.join(DIST, rel);
      const relToDist = path.relative(DIST, file);
      if (relToDist.startsWith('..') || path.isAbsolute(relToDist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(DIST, 'index.html');
      }
      const MIME: Record<string, string> = {
        '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
        '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
        '.woff2': 'font/woff2', '.png': 'image/png',
      };
      return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
    }

    throw notFound();
  } catch (e) {
    const status = e instanceof AppError ? e.status : ERROR_CODES.INTERNAL_ERROR;
    const message = e instanceof Error ? e.message : String(e);
    const details = e instanceof AppError ? e.details : null;
    if (status >= ERROR_CODES.INTERNAL_ERROR) logger.error('request failed', e);
    return send(res, status, JSON.stringify({ error: message, details }));
  }
});

const PORT = Number(process.env.API_PORT) || DEFAULT_PORT;
server.listen(PORT, () => logger.info(`api on http://localhost:${PORT}`));

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[api] ${signal} received, shutting down`);
  const forceExit = setTimeout(() => process.exit(1), 5000);
  forceExit.unref();
  server.close(() => {
    try {
      closeDb();
    } catch {
      /* already closed */
    }
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

fetchWindow('AAPL.US', '1d', null, null, 2)
  .then(() => logger.info('longbridge warm-up ok'))
  .catch((e) => logger.warn('longbridge warm-up failed:', e.message));

// Pre-fetch the US symbol universe so the picker's first open is instant.
usSymbols()
  .then((rows) => logger.info(`symbol universe ready: ${rows.length} US symbols`))
  .catch((e) => logger.warn('symbol universe failed:', e.message));
