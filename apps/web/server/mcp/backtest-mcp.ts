import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const RUN_ID = process.env.BACKTEST_RUN_ID || '';
const CONTROL_URL = (process.env.BACKTEST_CONTROL_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.BACKTEST_CONTROL_TOKEN || '';
const REQUEST_TIMEOUT_MS = 60_000;

type ToolCallResult = { ok?: boolean; [key: string]: unknown };

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
  if (!RUN_ID || !CONTROL_URL || !TOKEN) throw new Error('backtest MCP bridge is missing its run identity');
  const res = await fetch(`${CONTROL_URL}/${encodeURIComponent(RUN_ID)}/tool`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-backtest-token': TOKEN },
    body: JSON.stringify({ name, args }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`control ${res.status}: ${text.slice(0, 300)}`);
  const payload = JSON.parse(text) as { code: number; message: string; data?: { result?: ToolCallResult } };
  if (payload.code !== 0) throw new Error(`control ${payload.code}: ${payload.message}`);
  return payload.data?.result ?? { ok: false };
}

function present(result: ToolCallResult) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    isError: result.ok !== true,
  };
}

function tool(name: string, title: string, description: string, inputSchema: Record<string, z.ZodType>) {
  return { name, title, description, inputSchema };
}

function createBacktestServer(): McpServer {
  const server = new McpServer({ name: 'vela-backtest', version: '0.2.0' });

  const register = (definition: {
    name: string;
    title: string;
    description: string;
    inputSchema: Record<string, z.ZodType>;
  }) => {
    server.registerTool(
      definition.name,
      { title: definition.title, description: definition.description, inputSchema: definition.inputSchema },
      async (args: Record<string, unknown>) => {
        try {
          return present(await callTool(definition.name, args));
        } catch (error) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: false,
                  error: { message: error instanceof Error ? error.message : String(error) },
                }),
              },
            ],
            isError: true,
          };
        }
      },
    );
  };

  register(
    tool(
      'market_get_context',
      'Get decision context',
      'Current session, account, position, working orders and entry quota.',
      {},
    ),
  );
  register(
    tool(
      'market_get_bars',
      'Get closed bars',
      'Closed bars up to the current decision time. Future bars are never available.',
      {
        limit: z.number().int().min(1).max(500).optional(),
        from: z.union([z.string(), z.number()]).optional(),
        to: z.union([z.string(), z.number()]).optional(),
      },
    ),
  );
  register(tool('account_get', 'Get account', 'Cash, equity, buying power and realized/unrealized PnL.', {}));
  register(tool('position_list', 'List position', 'The current position for this run, if any.', {}));
  register(tool('order_list', 'List working orders', 'Working orders only.', {}));
  register(
    tool('order_place_limit', 'Place limit entry', '下限价开仓单。qty 可省略，省略时由系统按仓位配置计算。', {
      side: z.enum(['buy', 'sell']),
      qty: z.number().int().min(1).optional(),
      limitPrice: z.number().positive(),
      rationale: z.string().optional(),
    }),
  );
  register(
    tool('order_place_market', 'Place market entry', '下市价开仓单。qty 可省略，省略时由系统按仓位配置计算。', {
      side: z.enum(['buy', 'sell']),
      qty: z.number().int().min(1).optional(),
      rationale: z.string().optional(),
    }),
  );
  register(
    tool(
      'order_place_conditional',
      'Place conditional order',
      'Place a stop or take-profit order. Set reduceOnly=true for exits.',
      {
        side: z.enum(['buy', 'sell']),
        qty: z.number().int().min(1).optional(),
        kind: z.enum(['stop_market', 'stop_limit', 'take_profit_limit']),
        triggerPrice: z.number().positive().optional(),
        limitPrice: z.number().positive().optional(),
        reduceOnly: z.boolean().optional(),
        rationale: z.string().optional(),
      },
    ),
  );
  register(
    tool('order_amend', 'Amend working order', 'Change price and/or quantity of a working order.', {
      orderId: z.string(),
      qty: z.number().int().min(1).optional(),
      limitPrice: z.number().positive().optional(),
      triggerPrice: z.number().positive().optional(),
    }),
  );
  register(tool('order_cancel', 'Cancel working order', 'Cancel a working order.', { orderId: z.string() }));
  register(
    tool('position_close_limit', 'Close position with limit', 'Close all or part of the position with a limit order.', {
      limitPrice: z.number().positive(),
      qty: z.number().int().min(1).optional(),
      rationale: z.string().optional(),
    }),
  );
  register(
    tool(
      'position_close_market',
      'Close position at market',
      'Close all or part of the position with a market order.',
      {
        qty: z.number().int().min(1).optional(),
        rationale: z.string().optional(),
      },
    ),
  );
  register(
    tool('decision_finish', 'Finish decision', '结束本轮决策；即使不交易也要调用。summary 必须使用简体中文。', {
      summary: z.string(),
      noTradeReason: z.string().optional(),
    }),
  );

  return server;
}

async function main(): Promise<void> {
  const server = createBacktestServer();
  await server.connect(new StdioServerTransport());
  process.stderr.write(`[backtest-mcp] connected, run=${RUN_ID}\n`);
}

const isMain = Boolean(process.argv[1]) && import.meta.filename === process.argv[1];
if (isMain) {
  main().catch((error) => {
    process.stderr.write(
      `[backtest-mcp] fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  });
}
