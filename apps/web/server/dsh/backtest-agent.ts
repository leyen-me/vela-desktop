import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DeepSeekHarness, type HarnessSession } from '@deepseek-ai/dsh-sdk-client';
import {
  type BacktestAgent,
  type DecisionInput,
  type LlmAgentEvent,
  type ToolResult,
  executeBacktestTool,
} from '@vela/trading-core';
import { loadAgentConfig } from '../agent.ts';
import { logger } from '../logger.ts';
import {
  assertDshNode,
  DSH_BACKTEST_REASONING_EFFORT,
  DSH_BACKTEST_TIMEOUT_MS,
  DSH_INIT_TIMEOUT_MS,
  DSH_MODEL,
  DSH_PROVIDER,
  DSH_ROOT,
  DSH_WORKSPACE,
  ensureDshDirs,
} from './config.ts';
import { removePatch, writePatch } from './patch.ts';

type HarnessOptions = NonNullable<ConstructorParameters<typeof DeepSeekHarness>[0]>;
type Notification = { method: string; params: Record<string, unknown> };

export type DshBacktestOptions = {
  runId: string;
  controlToken: string;
  controlUrl: string;
  signal?: AbortSignal;
  onEvent?: (event: LlmAgentEvent) => void;
};

const MAX_TOOL_CALLS_PER_DECISION = 16;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clock(ms: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(ms));
}

function iso(ms: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(ms));
}

function formatBar(bar: DecisionInput['bars'][number], timezone: string): string {
  return `${clock(bar.closeTime, timezone)} O${bar.open} H${bar.high} L${bar.low} C${bar.close} V${bar.volume}`;
}

function instructions(input: DecisionInput): string {
  const plan = input.session;
  return [
    '你是一名美股日内交易 Agent，正在执行单日回测。',
    '必须始终使用简体中文进行思考（reasoning）和最终回答（content / summary），禁止使用英文。',
    '工具名和 JSON 字段名保持英文；rationale、summary 等自然语言内容必须使用简体中文。',
    '只允许交易给定的标的和时段，所有时间均为美东时间。',
    `标的与周期：${plan.date} ${plan.timeframe} ${input.bars[0]?.symbol ?? ''}`,
    `交易时段：${clock(plan.open, plan.timezone)}-${clock(plan.close, plan.timezone)}；${clock(plan.flattenAt, plan.timezone)} 起停止开仓并强制平仓。`,
    '优先省略 qty，由系统按仓位配置自动计算数量；不要猜测数量上限。',
    '禁止对已有持仓加仓；只有在空仓时才能建立新仓位。',
    '风控允许时可以做多或做空。',
    '系统会在强平时间平掉所有持仓，禁止隔夜。',
    '保护性止损/止盈使用条件单，平仓方向的条件单设置 reduceOnly=true。',
    '只能使用工具返回的价格和 K 线数据，禁止编造价格、新闻或指标数值。',
    '工具返回 ok=false 表示被拒绝：先阅读错误码和原因，不要盲目重复同一笔订单。',
    '每轮决策结束时必须调用 decision_finish。',
    '最终 summary 要简短、具体，并使用简体中文。',
  ].join('\n');
}

function contextMessage(input: DecisionInput, first: boolean, lastAsOf: number | null): string {
  const bars = first
    ? input.bars.slice(-160)
    : input.bars.filter((bar) => lastAsOf == null || bar.closeTime > lastAsOf);
  const snapshot = {
    asOf: iso(input.asOf, input.session.timezone),
    session: {
      open: clock(input.session.open, input.session.timezone),
      close: clock(input.session.close, input.session.timezone),
      flattenAt: clock(input.session.flattenAt, input.session.timezone),
      timeframe: input.session.timeframe,
      earlyClose: input.session.isEarlyClose,
    },
    account: input.account,
    position: input.position,
    workingOrders: input.orders,
    entryQuota: input.entryQuota,
    lastPrice: input.lastPrice,
    limits: input.limits,
  };
  return [
    ...(first ? [instructions(input), ''] : []),
    first ? '初始上下文：' : '本轮上下文：',
    JSON.stringify(snapshot, null, 2),
    '',
    first ? `初始已收盘 K 线（由旧到新，最近 ${bars.length} 根）：` : `本轮新增已收盘 K 线（${bars.length} 根）：`,
    ...bars.map((bar) => formatBar(bar, input.session.timezone)),
    '',
    first ? '如需更早历史，可调用 market_get_bars。' : '上轮对话仍在上下文中，请结合此前的判断和持仓计划继续决策。',
    '请使用简体中文进行思考，并用简体中文给出最终回答。',
  ].join('\n');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toolResultText(message: Record<string, unknown>): string {
  const content = Array.isArray(message.content) ? message.content : [];
  return content.map((block) => (isRecord(block) && typeof block.text === 'string' ? block.text : '')).join('');
}

export class DshBacktestAgent implements BacktestAgent {
  private readonly options: DshBacktestOptions;
  private harness: DeepSeekHarness | null = null;
  private session: HarnessSession | null = null;
  private patchPath: string | null = null;
  private activeInput: DecisionInput | null = null;
  private lastAsOf: number | null = null;
  private finished = false;
  private toolCalls = 0;
  private closed = false;
  private readonly seen = new Set<string>();
  private readonly callNames = new Map<string, string>();
  private readonly emitEvent: (event: LlmAgentEvent) => void;

  constructor(options: DshBacktestOptions) {
    this.options = options;
    this.emitEvent = options.onEvent ?? (() => {});
  }

  private sessionId(): string {
    return `session-${createHash('sha256').update(`vela-backtest:${this.options.runId}`).digest('hex').slice(0, 32)}`;
  }

  private getHarness(): DeepSeekHarness {
    if (this.harness) return this.harness;
    assertDshNode();
    ensureDshDirs();
    this.patchPath = writePatch(`backtest-${this.options.runId}.yml`, [
      {
        id: 'mcp-backtest',
        serverName: 'backtest',
        command: process.execPath,
        args: [fileURLToPath(new URL('../mcp/backtest-mcp.ts', import.meta.url))],
        env: {
          BACKTEST_RUN_ID: this.options.runId,
          BACKTEST_CONTROL_URL: this.options.controlUrl,
          BACKTEST_CONTROL_TOKEN: this.options.controlToken,
        },
      },
    ]);
    const options: HarnessOptions = {
      profile: 'sdk',
      patches: [this.patchPath],
      dshHome: path.join(DSH_ROOT, 'backtest-home'),
      cwd: DSH_WORKSPACE,
      processCwd: DSH_WORKSPACE,
      initializeTimeoutMs: DSH_INIT_TIMEOUT_MS,
      requestTimeoutMs: DSH_BACKTEST_TIMEOUT_MS,
      provider: DSH_PROVIDER,
      model: DSH_MODEL,
    };
    options.reasoningEffort = DSH_BACKTEST_REASONING_EFFORT as NonNullable<HarnessOptions['reasoningEffort']>;
    const configured = loadAgentConfig();
    if (configured.key) options.env = { ...process.env, DEEPSEEK_API_KEY: configured.key };
    this.harness = new DeepSeekHarness(options);
    return this.harness;
  }

  private ensureSession(): HarnessSession {
    if (this.session) return this.session;
    this.session = this.getHarness().session(this.sessionId());
    return this.session;
  }

  private handleNotification(notification: Notification): void {
    if (notification.method !== 'session.event') return;
    const event = notification.params.event;
    if (!isRecord(event) || typeof event.type !== 'string') return;
    const data = isRecord(event.data) ? event.data : {};

    if (event.type === 'tool/call') {
      const id = typeof data.callId === 'string' ? data.callId : '';
      const name = typeof data.name === 'string' ? data.name : 'tool';
      if (id) this.callNames.set(id, name);
      this.emitEvent({ type: 'tool_call', id, name, args: parseJson(String(data.arguments ?? '{}')) });
      return;
    }

    if (event.type === 'tool/result') {
      const message = isRecord(data.message) ? data.message : {};
      const source = isRecord(message.source) ? message.source : {};
      const id =
        (typeof message.toolCallId === 'string' && message.toolCallId) ||
        (typeof source.callId === 'string' && source.callId) ||
        '';
      const name = (id && this.callNames.get(id)) || 'tool';
      const result = parseJson(toolResultText(message)) as ToolResult<unknown>;
      this.emitEvent({ type: 'tool_result', id, name, result });
      return;
    }

    if (event.type === 'assistant/message') {
      const message = isRecord(data.message) ? data.message : {};
      const id = typeof message.id === 'string' ? message.id : '';
      if (id) {
        if (this.seen.has(id)) return;
        this.seen.add(id);
      }
      const blocks = Array.isArray(message.content) ? message.content : [];
      for (const block of blocks) {
        if (!isRecord(block) || typeof block.text !== 'string' || !block.text) continue;
        if (block.type === 'reasoning') this.emitEvent({ type: 'reasoning', delta: block.text });
        else if (block.type === 'text') this.emitEvent({ type: 'assistant', content: block.text });
      }
    }
  }

  /** Called by the API server when the MCP bridge proxies one model tool call. */
  executeTool(name: string, args: Record<string, unknown>): ToolResult<unknown> {
    if (!this.activeInput) {
      return {
        version: 1,
        ok: false,
        tool: name,
        error: { code: 'INTERNAL', message: 'No active decision to execute against', retryable: false },
        meta: {},
      } as ToolResult<unknown>;
    }
    if (this.toolCalls >= MAX_TOOL_CALLS_PER_DECISION) {
      return {
        version: 1,
        ok: false,
        tool: name,
        error: { code: 'INTERNAL', message: `单轮工具调用超过上限 ${MAX_TOOL_CALLS_PER_DECISION}`, retryable: false },
        meta: {},
      } as ToolResult<unknown>;
    }
    this.toolCalls += 1;
    const executed = executeBacktestTool(name, args, this.activeInput);
    if (executed.finish != null) {
      this.finished = true;
      this.emitEvent({ type: 'finish', summary: executed.finish });
    }
    return executed.result;
  }

  async decide(input: DecisionInput): Promise<readonly []> {
    if (this.options.signal?.aborted) throw new DOMException('Backtest aborted', 'AbortError');
    const first = this.lastAsOf == null;
    const message = contextMessage(input, first, this.lastAsOf);
    this.lastAsOf = input.asOf;
    this.activeInput = input;
    this.finished = false;
    this.toolCalls = 0;
    try {
      const session = this.ensureSession();
      await session.run(message, { onNotification: (notification) => this.handleNotification(notification) });
      if (!this.finished) {
        await session.run(
          '你上一轮没有调用 decision_finish。现在必须调用 decision_finish 结束本轮决策；不要只返回普通文本。',
          {
            onNotification: (notification) => this.handleNotification(notification),
          },
        );
      }
    } catch (error) {
      if (this.options.signal?.aborted) throw new DOMException('Backtest aborted', 'AbortError');
      logger.warn('[dsh-backtest] decision failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.activeInput = null;
    }
    return [];
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const current = this.harness;
    this.harness = null;
    this.session = null;
    if (this.patchPath) removePatch(this.patchPath);
    this.patchPath = null;
    if (current) {
      await current.close().catch((error) => {
        logger.warn('[dsh-backtest] close failed', { message: error instanceof Error ? error.message : String(error) });
      });
    }
  }
}
