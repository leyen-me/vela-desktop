import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_BASE = (process.env.VELA_API_BASE || `http://127.0.0.1:${process.env.API_PORT || 5174}/api/v1`).replace(
  /\/+$/,
  '',
);
const REQUEST_TIMEOUT_MS = 30_000;

type Envelope<T> = { code: number; message: string; data: T; timestamp: number };

async function getJson<T>(pathname: string, params: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(`${API_BASE}${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== '') url.searchParams.set(key, String(value));
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const text = await res.text();
  if (!res.ok) throw new Error(`trading API ${res.status}: ${text.slice(0, 300)}`);
  let payload: Envelope<T>;
  try {
    payload = JSON.parse(text) as Envelope<T>;
  } catch {
    throw new Error(`trading API returned non-JSON: ${text.slice(0, 300)}`);
  }
  if (payload.code !== 0) throw new Error(`trading API ${payload.code}: ${payload.message}`);
  return payload.data;
}

function ok(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function fail(error: unknown) {
  return {
    content: [
      { type: 'text' as const, text: `tool failed: ${error instanceof Error ? error.message : String(error)}` },
    ],
    isError: true,
  };
}

export function createTradingServer(): McpServer {
  const server = new McpServer({ name: 'vela-trading', version: '0.2.0' });

  server.registerTool(
    'market_bars',
    {
      title: 'Get market bars',
      description:
        'Fetch OHLCV bars for a US symbol. Omit from/to for the most recent bars. Times are epoch milliseconds (UTC).',
      inputSchema: {
        symbol: z.string().describe('Symbol with market suffix, e.g. NVDA.US'),
        timeframe: z.string().describe('Bar timeframe: 1m, 5m, 15m, 30m, 1h, 2h, 4h, 1d'),
        limit: z.number().int().min(1).max(2000).optional().describe('Number of bars, default 200'),
        from: z.number().int().optional().describe('Start time, epoch milliseconds'),
        to: z.number().int().optional().describe('End time, epoch milliseconds'),
      },
    },
    async ({ symbol, timeframe, limit, from, to }) => {
      try {
        const data = await getJson<{ symbol: string; tf: string; source: string; bars: unknown[] }>('/bars', {
          symbol,
          tf: timeframe,
          limit: limit ?? 200,
          from,
          to,
        });
        return ok({
          symbol: data.symbol,
          timeframe: data.tf,
          source: data.source,
          count: Array.isArray(data.bars) ? data.bars.length : 0,
          bars: data.bars,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'market_session',
    {
      title: 'Get US trading session plan',
      description:
        'Fetch the session open/close/flatten schedule for a US symbol and date, useful before planning intraday trades.',
      inputSchema: {
        symbol: z.string().describe('Symbol with market suffix, e.g. NVDA.US'),
        date: z.string().describe('Market-local date, YYYY-MM-DD'),
        timeframe: z.string().describe('Decision timeframe: 1m, 5m, 15m, 30m, 1h, 2h, 4h'),
      },
    },
    async ({ symbol, date, timeframe }) => {
      try {
        const data = await getJson<Record<string, unknown>>('/backtest/session', { symbol, date, timeframe });
        return ok(data);
      } catch (error) {
        return fail(error);
      }
    },
  );

  return server;
}

async function main(): Promise<void> {
  const server = createTradingServer();
  await server.connect(new StdioServerTransport());
  process.stderr.write(`[trading-mcp] connected, api=${API_BASE}\n`);
}

const isMain = Boolean(process.argv[1]) && import.meta.filename === process.argv[1];
if (isMain) {
  main().catch((error) => {
    process.stderr.write(
      `[trading-mcp] fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  });
}
