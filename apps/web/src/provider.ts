import { API_BASE, api } from './api.ts';
import type { Paginated, SymbolDto } from '../shared/contracts.ts';
import type { Bar, BarRange, SymbolRow } from './types.ts';

export const TF_MAP: Record<string, string> = {
  '1': '1m', '5': '5m', '15': '15m', '30': '30m',
  '60': '1h', '120': '2h', '240': '4h',
  D: '1d', W: '1w', M: '1M',
  '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1h', '2h': '2h', '4h': '4h',
  '1d': '1d', '1w': '1w', '1M': '1M',
};
export const TF_MS: Record<string, number> = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000,
  '1d': 86_400_000, '1w': 604_800_000, '1M': 2_592_000_000,
};
// TradingView's datafeed asks for the bars that fill the visible area — typically
// around 300 — and fetches older history as the user scrolls. Mirror that: boot with
// a small window and extend it page by page on demand.
export const INITIAL_BARS = 300;
export const SLIDE_BARS = 1000;
export const MAX_BARS = 20_000;

// Provider-side bookkeeping for the lazy history: the oldest bar delivered for each
// market, and whether the source ran out of older data.
export const oldestByMarket = new Map<string, number>();
export const newestByMarket = new Map<string, number>();
export const exhaustedMarkets = new Set<string>();

export class LongbridgeProvider {
  async getBars(ticker: string, timeframe: string, range?: BarRange): Promise<Bar[]> {
    const tf = TF_MAP[timeframe] || '1d';
    const params = new URLSearchParams({
      symbol: ticker,
      tf,
      count: String(range?.limit || 500),
    });
    if (range?.from != null) params.set('from', String(range.from));
    if (range?.to != null) params.set('to', String(range.to));
    let lastErr: unknown;
    for (let i = 0; i < 3; i++) {
      try {
        const data = await api.get(`/bars?${params}`);
        const bars = data?.bars as Bar[] | undefined;
        if (!Array.isArray(bars)) throw new Error('invalid bars response');
        const key = `${ticker}|${tf}`;
        const unbounded = range?.from == null && range?.to == null;
        if (bars.length > 0) {
          // A full request redefines the window (symbol/timeframe switch); an older
          // window only ever pushes the left edge further back.
          const previousOldest = oldestByMarket.get(key);
          if (unbounded || previousOldest == null || bars[0].time < previousOldest) {
            oldestByMarket.set(key, bars[0].time);
          }
          const newest = bars[bars.length - 1].time;
          const previousNewest = newestByMarket.get(key);
          if (unbounded || previousNewest == null || newest > previousNewest) {
            newestByMarket.set(key, newest);
          }
        }
        if (unbounded) exhaustedMarkets.delete(key);
        else if (range?.limit && bars.length < range.limit) exhaustedMarkets.add(key);
        return bars;
      } catch (e) {
        lastErr = e;
        await new Promise((res) => setTimeout(res, 700 * (i + 1)));
      }
    }
    throw lastErr;
  }

  subscribe(ticker: string, timeframe: string, onBar: (bar: Bar) => void): () => void {
    const tf = TF_MAP[timeframe] || '1d';
    const params = new URLSearchParams({ symbol: ticker, tf });
    const es = new EventSource(`${API_BASE}/stream?${params}`);
    es.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (!msg?.bar) return;
        const key = `${ticker}|${tf}`;
        const newest = newestByMarket.get(key);
        if (newest == null || msg.bar.time > newest) newestByMarket.set(key, msg.bar.time);
        if (msg.confirmed) {
          window.dispatchEvent(new CustomEvent('vela:bar-close', {
            detail: { symbol: ticker, timeframe: tf, bar: msg.bar },
          }));
        }
        onBar(msg.bar);
      } catch {
        /* malformed frame — keep the stream open */
      }
    };
    es.addEventListener('stream-error', (event) => {
      let message = 'unknown error';
      try { message = JSON.parse(event.data).message; } catch { /* keep the generic message */ }
      console.warn('[longbridge] candlestick stream failed:', message);
    });
    return () => es.close();
  }

  async listSymbols() {
    const rows: SymbolRow[] = [];
    for (let page = 1; ; page += 1) {
      const data = await api.get<Paginated<SymbolDto>>(`/symbols?page=${page}&pageSize=5000`);
      rows.push(...(data?.items ?? []));
      if (rows.length >= (data?.total ?? 0) || !data?.items?.length) break;
    }
    return rows.map((s) => ({
      ticker: s.ticker, description: s.description, type: s.type, section: s.section,
    }));
  }

  info() {
    return {
      name: 'longbridge',
      displayName: '长桥',
      supportedTimeframes: Object.keys(TF_MAP),
      capabilities: { enumerate: true, stream: true, symbolInfo: false },
    };
  }
}

