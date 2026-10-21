import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BAR_PAGE_SIZE, DAILY_TTL_MS, INTRADAY_TTL_MS, US_SYMBOLS_TTL_MS } from './config.ts';
import { logger } from './logger.ts';
import type { BarDto, SymbolDto } from '../shared/contracts.ts';

type Bar = BarDto;
type SymbolRow = SymbolDto;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '..', '..', '..', 'data', 'cache');

const { Config, QuoteContext, Period, AdjustType, TradeSessions, NaiveDate, NaiveDatetime, Time, Market } =
  await import('longport');

export const TF: Record<string, any> = {
  '1m': Period.Min_1, '5m': Period.Min_5, '15m': Period.Min_15, '30m': Period.Min_30,
  '1h': Period.Min_60, '2h': Period.Min_120, '4h': Period.Min_240,
  '1d': Period.Day, '1w': Period.Week, '1M': Period.Month,
};

// Chart UI values ('5', '60', 'D') -> the labels the agent prompt and UI speak.
const AGENT_TF_LABEL: Record<string, string> = {
  '1': '1m', '5': '5m', '15': '15m', '30': '30m', '60': '1h', '120': '2h', '240': '4h',
  D: '1d', W: '1w', M: '1M',
};
export function agentTfLabel(tf: string): string {
  return AGENT_TF_LABEL[tf] || tf || 'unknown';
}

// Longbridge caps a single candlestick request at 1000 bars — deeper windows page.
// Hard ceiling for one HTTP request from the client (Vela backfills in ~10000-bar chunks).

// Longbridge history anchors are NAIVE datetimes interpreted in the MARKET's timezone.
const TZ_BY_SUFFIX: Array<[string, string]> = [
  ['.US', 'America/New_York'], ['.HK', 'Asia/Hong_Kong'],
  ['.SH', 'Asia/Shanghai'], ['.SZ', 'Asia/Shanghai'],
];
export function tzForSymbol(symbol: string): string {
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

export const ttlOf = (tf: string): number => (/[hm]$/.test(tf) ? INTRADAY_TTL_MS : DAILY_TTL_MS);

let ctxPromise: any = null;
export function getCtx(): any {
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

// The SDK pushes through one socket owned by the QuoteContext, so subscriptions are
// reference-counted per (symbol, timeframe) and fanned out to every connected client.
export const PERIOD_TF = new Map<unknown, string>(Object.entries(TF).map(([tf, period]) => [period, tf]));
export type CandleEvent = { symbol: string; tf: string; period: unknown; bar: Bar; confirmed: boolean };
let candleListener: ((event: CandleEvent) => void) | null = null;
let pushBound = false;

export function setCandleListener(listener: (event: CandleEvent) => void): void {
  candleListener = listener;
}

export function bindCandlestickPush(ctx: any): void {
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
      const bar = toBar(event.data.candlestick);
      candleListener?.({ symbol: event.symbol, tf, period: event.data.period, bar, confirmed: event.data.isConfirmed });
    } catch (e) {
      logger.warn('[push] frame failed:', (e as Error).message);
    }
  });
}

export async function subscribeCandlesticks(symbol: string, period: unknown): Promise<void> {
  const ctx = await getCtx();
  await ctx.subscribeCandlesticks(symbol, period, TradeSessions.Intraday);
}

export async function unsubscribeCandlesticks(symbol: string, period: unknown): Promise<void> {
  const ctx = await getCtx();
  await ctx.unsubscribeCandlesticks(symbol, period);
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
export async function fetchWindow(symbol: string, tf: string, from: number | null, to: number | null, limit: number): Promise<{ bars: Bar[]; hitGenesis: boolean }> {
  const period = TF[tf];
  const tz = tzForSymbol(symbol);
  const ctx = await getCtx();
  const byTime = new Map<number, Bar>();
  let anchor = to; // null -> latest
  let hitGenesis = false;

  const maxPages = Math.ceil(limit / (BAR_PAGE_SIZE - 1)) + 4;
  for (let page = 0; byTime.size < limit && page < maxPages; page++) {
    // The API's backward query is anchor-INCLUSIVE, so an anchored page wastes one
    // slot on the boundary bar we already have — ask for one extra to compensate.
    const want = Math.min(BAR_PAGE_SIZE, limit - byTime.size + (anchor != null ? 1 : 0));
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
const US_SYMBOLS_TTL = US_SYMBOLS_TTL_MS;
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

export async function usSymbols(): Promise<SymbolRow[]> {
  if (usSymbolsMem) return usSymbolsMem;
  try {
    if (Date.now() - fs.statSync(US_SYMBOLS_FILE).mtimeMs < US_SYMBOLS_TTL) {
      const rows = JSON.parse(fs.readFileSync(US_SYMBOLS_FILE, 'utf8')) as SymbolRow[];
      if (Array.isArray(rows) && rows.length) {
        usSymbolsMem = orderUsSymbols(rows);
        return usSymbolsMem;
      }
    }
  } catch (error) {
    logger.warn('us symbols cache unreadable:', (error as Error).message);
  }
  try {
    const ctx = await getCtx();
    const list = await ctx.securityList(Market.US);
    const rows = list
      .filter((s: any) => /^[A-Z0-9]+\.US$/.test(s.symbol)) // drop warrants/units/structured (suffixed) tickers
      .map((s: any) => ({ ticker: s.symbol, description: s.nameEn || s.nameCn || '', type: 'stock' }));
    usSymbolsMem = orderUsSymbols(rows);
    try {
      fs.writeFileSync(US_SYMBOLS_FILE, JSON.stringify(usSymbolsMem));
    } catch (error) {
      logger.warn('us symbols cache write failed:', (error as Error).message);
    }
    return usSymbolsMem;
  } catch (e) {
    logger.warn('securityList failed:', (e as Error).message);
    return orderUsSymbols(SYMBOLS.map(([ticker, description, type]) => ({ ticker, description, type })));
  }
}

