import { DomainError, failure, success } from './errors.ts';
import type {
    BacktestAgent,
    BacktestToolHost,
    Bar,
    DecisionInput,
    OrderRequest,
    ToolResult,
} from './types.ts';

export interface ChatToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    tool_calls?: ChatToolCall[];
    tool_call_id?: string;
}

export interface ToolDefinition {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}

export interface ChatUsage {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
}

export interface ChatResponse {
    message: {
        content?: string | null;
        reasoningContent?: string | null;
        tool_calls?: ChatToolCall[];
    };
    finishReason?: string;
    usage?: ChatUsage;
}

export type ChatStreamEvent =
    | { type: 'reasoning'; delta: string }
    | { type: 'content'; delta: string }
    | {
        type: 'tool_call_delta';
        index: number;
        id?: string;
        name?: string;
        argumentsDelta?: string;
    }
    | { type: 'usage'; usage: ChatUsage };

export interface ChatRequest {
    model: string;
    messages: ChatMessage[];
    tools: ToolDefinition[];
    tool_choice: 'auto' | 'none';
    temperature?: number;
    max_tokens?: number;
    reasoning_effort?: 'low' | 'high' | 'max';
}

export interface ChatClient {
    chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
    chatStream?(
        request: ChatRequest,
        signal: AbortSignal | undefined,
        onEvent: (event: ChatStreamEvent) => void,
    ): Promise<ChatResponse>;
}

export type LlmAgentEvent =
    | { type: 'assistant'; content: string }
    | { type: 'reasoning'; delta: string }
    | { type: 'content'; delta: string }
    | { type: 'tool_call'; id: string; name: string; args: unknown }
    | { type: 'tool_result'; id: string; name: string; result: ToolResult<unknown> }
    | { type: 'finish'; summary: string }
    | { type: 'usage'; usage: ChatUsage }
    | { type: 'error'; message: string };

export interface LlmAgentOptions {
    client: ChatClient;
    model: string;
    maxIterations?: number;
    maxToolCalls?: number;
    temperature?: number;
    maxTokens?: number;
    reasoningEffort?: 'low' | 'high' | 'max';
    timeoutMs?: number;
    signal?: AbortSignal;
    onEvent?: (event: LlmAgentEvent) => void;
}

const TOOLS: ToolDefinition[] = [
    {
        type: 'function',
        function: {
            name: 'market_get_context',
            description: 'Current session, account, position, working orders and entry quota.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
    },
    {
        type: 'function',
        function: {
            name: 'market_get_bars',
            description: 'Closed bars up to the current decision time. Future bars are never available.',
            parameters: {
                type: 'object',
                properties: {
                    limit: { type: 'integer', minimum: 1, maximum: 500 },
                    from: { type: 'string', description: 'ISO time or epoch ms' },
                    to: { type: 'string', description: 'ISO time or epoch ms' },
                },
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'account_get',
            description: 'Cash, equity, buying power and realized/unrealized PnL.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
    },
    {
        type: 'function',
        function: {
            name: 'position_list',
            description: 'The current position for this run, if any.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
    },
    {
        type: 'function',
        function: {
            name: 'order_list',
            description: 'Working orders only.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
    },
    {
        type: 'function',
        function: {
            name: 'order_place_limit',
            description: '下限价开仓单。qty 可省略，省略时由系统按仓位配置计算；若填写不得超过当前上限。',
            parameters: {
                type: 'object',
                properties: {
                    side: { type: 'string', enum: ['buy', 'sell'] },
                    qty: { type: 'integer', minimum: 1 },
                    limitPrice: { type: 'number', exclusiveMinimum: 0 },
                    rationale: { type: 'string', description: '使用简体中文说明交易理由' },
                },
                required: ['side', 'limitPrice'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'order_place_market',
            description: '下市价开仓单。qty 可省略，省略时由系统按仓位配置计算；若填写不得超过当前上限。',
            parameters: {
                type: 'object',
                properties: {
                    side: { type: 'string', enum: ['buy', 'sell'] },
                    qty: { type: 'integer', minimum: 1 },
                    rationale: { type: 'string', description: '使用简体中文说明交易理由' },
                },
                required: ['side'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'order_place_conditional',
            description: 'Place a stop or take-profit order. Set reduceOnly=true for exits.',
            parameters: {
                type: 'object',
                properties: {
                    side: { type: 'string', enum: ['buy', 'sell'] },
                    qty: { type: 'integer', minimum: 1 },
                    kind: {
                        type: 'string',
                        enum: ['stop_market', 'stop_limit', 'take_profit_limit'],
                    },
                    triggerPrice: { type: 'number', exclusiveMinimum: 0 },
                    limitPrice: { type: 'number', exclusiveMinimum: 0 },
                    reduceOnly: { type: 'boolean' },
                    rationale: { type: 'string', description: '使用简体中文说明交易理由' },
                },
                required: ['side', 'kind'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'order_amend',
            description: 'Change price and/or quantity of a working order.',
            parameters: {
                type: 'object',
                properties: {
                    orderId: { type: 'string' },
                    qty: { type: 'integer', minimum: 1 },
                    limitPrice: { type: 'number', exclusiveMinimum: 0 },
                    triggerPrice: { type: 'number', exclusiveMinimum: 0 },
                },
                required: ['orderId'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'order_cancel',
            description: 'Cancel a working order.',
            parameters: {
                type: 'object',
                properties: { orderId: { type: 'string' } },
                required: ['orderId'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'position_close_limit',
            description: 'Close all or part of the position with a limit order.',
            parameters: {
                type: 'object',
                properties: {
                    limitPrice: { type: 'number', exclusiveMinimum: 0 },
                    qty: { type: 'integer', minimum: 1 },
                    rationale: { type: 'string', description: '使用简体中文说明交易理由' },
                },
                required: ['limitPrice'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'position_close_market',
            description: 'Close all or part of the position with a market order.',
            parameters: {
                type: 'object',
                properties: {
                    qty: { type: 'integer', minimum: 1 },
                    rationale: { type: 'string', description: '使用简体中文说明交易理由' },
                },
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'decision_finish',
            description: '结束本轮决策；即使不交易也要调用。summary 必须使用简体中文。',
            parameters: {
                type: 'object',
                properties: {
                    summary: { type: 'string' },
                    noTradeReason: { type: 'string' },
                },
                required: ['summary'],
                additionalProperties: false,
            },
        },
    },
];

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

function clock(ms: number, timezone: string): string {
    return new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).format(new Date(ms));
}

function formatBar(bar: Bar, timezone: string): string {
    return `${clock(bar.closeTime, timezone)} O${bar.open} H${bar.high} L${bar.low} C${bar.close} V${bar.volume}`;
}

function systemPrompt(input: DecisionInput): string {
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
        first ? '初始上下文：' : '本轮上下文：',
        JSON.stringify(snapshot, null, 2),
        '',
        first
            ? `初始已收盘 K 线（由旧到新，最近 ${bars.length} 根）：`
            : `本轮新增已收盘 K 线（${bars.length} 根）：`,
        ...bars.map((bar) => formatBar(bar, input.session.timezone)),
        '',
        first ? '如需更早历史，可调用 market_get_bars。' : '上轮对话仍在上下文中，请结合此前的判断和持仓计划继续决策。',
        '请使用简体中文进行思考，并用简体中文给出最终回答。',
    ].join('\n');
}

function asRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new DomainError('VALIDATION_ERROR', 'Tool arguments must be an object');
    }
    return value as Record<string, unknown>;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
    const value = args[key];
    if (value == null) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new DomainError('VALIDATION_ERROR', `${key} must be a number`);
    }
    return value;
}

function optionalInteger(args: Record<string, unknown>, key: string): number | undefined {
    const value = optionalNumber(args, key);
    if (value == null) return undefined;
    if (!Number.isInteger(value) || value <= 0) {
        throw new DomainError('VALIDATION_ERROR', `${key} must be a positive integer`);
    }
    return value;
}

function requiredNumber(args: Record<string, unknown>, key: string): number {
    const value = optionalNumber(args, key);
    if (value == null) throw new DomainError('VALIDATION_ERROR', `${key} is required`);
    return value;
}

function requiredString(args: Record<string, unknown>, key: string): string {
    const value = args[key];
    if (typeof value !== 'string' || value.length === 0) {
        throw new DomainError('VALIDATION_ERROR', `${key} must be a non-empty string`);
    }
    return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
    const value = args[key];
    if (value == null) return undefined;
    if (typeof value !== 'string') throw new DomainError('VALIDATION_ERROR', `${key} must be a string`);
    return value;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
    const value = args[key];
    if (value == null) return undefined;
    if (typeof value !== 'boolean') throw new DomainError('VALIDATION_ERROR', `${key} must be a boolean`);
    return value;
}

function parseTime(value: string | undefined): number | undefined {
    if (value == null || value === '') return undefined;
    if (/^\d+$/.test(value)) return Number(value);
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) throw new DomainError('VALIDATION_ERROR', `Invalid time "${value}"`);
    return parsed;
}

function wrapResult<T>(name: string, result: ToolResult<T>): ToolResult<T> {
    if (result.ok) return { ...result, tool: name };
    return { ...result, tool: name };
}

function executeTool(
    name: string,
    rawArgs: unknown,
    input: DecisionInput,
): { result: ToolResult<unknown>; finish?: string } {
    try {
        const args = rawArgs == null ? {} : asRecord(rawArgs);
        if (name === 'decision_finish') {
            const summary = requiredString(args, 'summary');
            return { result: success(name, { summary }), finish: summary };
        }
        if (name === 'market_get_context') {
            return {
                result: success(name, {
                    session: input.session,
                    asOf: input.asOf,
                    account: input.account,
                    position: input.position,
                    workingOrders: input.orders,
                    entryQuota: input.entryQuota,
                    lastPrice: input.lastPrice,
                    limits: input.limits,
                    barsAvailable: input.bars.length,
                }),
            };
        }
        if (name === 'market_get_bars') {
            const limit = Math.min(optionalInteger(args, 'limit') ?? 120, 500);
            const from = parseTime(optionalString(args, 'from'));
            const to = parseTime(optionalString(args, 'to'));
            const bars = input.bars
                .filter((bar) => (from == null || bar.closeTime >= from) && (to == null || bar.closeTime <= to))
                .slice(-limit)
                .map((bar) => ({ ...bar, closeTimeIso: iso(bar.closeTime, input.session.timezone) }));
            return { result: success(name, { bars }) };
        }
        if (name === 'account_get') {
            return { result: success(name, input.account) };
        }
        if (name === 'position_list') {
            return { result: success(name, { position: input.position }) };
        }
        if (name === 'order_list') {
            return { result: success(name, { orders: input.orders }) };
        }
        if (name === 'order_place_limit') {
            const side = requiredString(args, 'side');
            if (side !== 'buy' && side !== 'sell') throw new DomainError('VALIDATION_ERROR', 'side must be buy or sell');
            const request: OrderRequest = {
                symbol: input.position?.symbol ?? input.bars[0]?.symbol ?? '',
                side,
                kind: 'limit',
                limitPrice: requiredNumber(args, 'limitPrice'),
                ...(optionalInteger(args, 'qty') != null ? { qty: optionalInteger(args, 'qty') } : {}),
                ...(optionalString(args, 'rationale') ? { rationale: optionalString(args, 'rationale') } : {}),
            };
            return { result: wrapResult(name, input.tools.submitOrder(request)) };
        }
        if (name === 'order_place_market') {
            const side = requiredString(args, 'side');
            if (side !== 'buy' && side !== 'sell') throw new DomainError('VALIDATION_ERROR', 'side must be buy or sell');
            const request: OrderRequest = {
                symbol: input.position?.symbol ?? input.bars[0]?.symbol ?? '',
                side,
                kind: 'market',
                ...(optionalInteger(args, 'qty') != null ? { qty: optionalInteger(args, 'qty') } : {}),
                ...(optionalString(args, 'rationale') ? { rationale: optionalString(args, 'rationale') } : {}),
            };
            return { result: wrapResult(name, input.tools.submitOrder(request)) };
        }
        if (name === 'order_place_conditional') {
            const side = requiredString(args, 'side');
            if (side !== 'buy' && side !== 'sell') throw new DomainError('VALIDATION_ERROR', 'side must be buy or sell');
            const kind = requiredString(args, 'kind');
            if (kind !== 'stop_market' && kind !== 'stop_limit' && kind !== 'take_profit_limit') {
                throw new DomainError('VALIDATION_ERROR', 'Unsupported conditional order kind');
            }
            const positionQty = input.position?.qty ?? 0;
            const sideSign = side === 'buy' ? 1 : -1;
            const inferredReduceOnly = positionQty !== 0 && Math.sign(positionQty) !== sideSign;
            const request: OrderRequest = {
                symbol: input.position?.symbol ?? input.bars[0]?.symbol ?? '',
                side,
                kind,
                ...(optionalInteger(args, 'qty') != null ? { qty: optionalInteger(args, 'qty') } : {}),
                ...(optionalNumber(args, 'triggerPrice') != null
                    ? { triggerPrice: optionalNumber(args, 'triggerPrice') }
                    : {}),
                ...(optionalNumber(args, 'limitPrice') != null
                    ? { limitPrice: optionalNumber(args, 'limitPrice') }
                    : {}),
                reduceOnly: optionalBoolean(args, 'reduceOnly') ?? inferredReduceOnly,
                ...(optionalString(args, 'rationale') ? { rationale: optionalString(args, 'rationale') } : {}),
            };
            return { result: wrapResult(name, input.tools.submitOrder(request)) };
        }
        if (name === 'order_amend') {
            const orderId = requiredString(args, 'orderId');
            const patch = {
                ...(optionalInteger(args, 'qty') != null ? { qty: optionalInteger(args, 'qty') } : {}),
                ...(optionalNumber(args, 'limitPrice') != null
                    ? { limitPrice: optionalNumber(args, 'limitPrice') }
                    : {}),
                ...(optionalNumber(args, 'triggerPrice') != null
                    ? { triggerPrice: optionalNumber(args, 'triggerPrice') }
                    : {}),
            };
            return { result: wrapResult(name, input.tools.amendOrder(orderId, patch)) };
        }
        if (name === 'order_cancel') {
            return { result: wrapResult(name, input.tools.cancelOrder(requiredString(args, 'orderId'))) };
        }
        if (name === 'position_close_limit') {
            return {
                result: wrapResult(
                    name,
                    input.tools.closePosition({
                        kind: 'limit',
                        limitPrice: requiredNumber(args, 'limitPrice'),
                        ...(optionalInteger(args, 'qty') != null ? { qty: optionalInteger(args, 'qty') } : {}),
                    }),
                ),
            };
        }
        if (name === 'position_close_market') {
            return {
                result: wrapResult(
                    name,
                    input.tools.closePosition({
                        kind: 'market',
                        ...(optionalInteger(args, 'qty') != null ? { qty: optionalInteger(args, 'qty') } : {}),
                    }),
                ),
            };
        }
        return {
            result: failure(name, {
                code: 'UNKNOWN_TOOL',
                message: `Unknown tool "${name}"`,
                retryable: false,
            }),
        };
    } catch (error) {
        if (error instanceof DomainError) {
            return { result: failure(name, error.toPayload()) };
        }
        return {
            result: failure(name, {
                code: 'INTERNAL',
                message: error instanceof Error ? error.message : String(error),
                retryable: false,
            }),
        };
    }
}

export function createLlmBacktestAgent(options: LlmAgentOptions): BacktestAgent {
    const maxIterations = options.maxIterations ?? 4;
    const maxToolCalls = options.maxToolCalls ?? 8;
    const emit = options.onEvent ?? (() => {});
    let conversation: ChatMessage[] | null = null;
    let lastAsOf: number | null = null;
    return {
        async decide(input: DecisionInput): Promise<readonly []> {
            if (!conversation) {
                conversation = [{ role: 'system', content: systemPrompt(input) }];
            }
            const first = lastAsOf == null;
            conversation.push({
                role: 'user',
                content: contextMessage(input, first, lastAsOf),
            });
            lastAsOf = input.asOf;
            const messages = conversation;
            let toolCalls = 0;
            let finished = false;
            let maxTokens = options.maxTokens ?? 4096;
            const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 90_000);
            const signal = options.signal
                ? AbortSignal.any([timeoutSignal, options.signal])
                : timeoutSignal;
            try {
                for (let iteration = 0; iteration < maxIterations && !finished; iteration += 1) {
                            const request: ChatRequest = {
                        model: options.model,
                        messages,
                        tools: TOOLS,
                        tool_choice: 'auto',
                        temperature: options.temperature ?? 0.2,
                        max_tokens: maxTokens,
                        reasoning_effort: options.reasoningEffort ?? 'low',
                    };
                    const streaming = Boolean(options.client.chatStream);
                    const response = streaming
                        ? await options.client.chatStream!(request, signal, (event) => {
                            if (event.type === 'reasoning') emit({ type: 'reasoning', delta: event.delta });
                            else if (event.type === 'content') emit({ type: 'content', delta: event.delta });
                        })
                        : await options.client.chat(request, signal);
                    if (response.usage) emit({ type: 'usage', usage: response.usage });
                    const calls = response.message.tool_calls ?? [];
                    const content = response.message.content ?? '';
                    if (!streaming) {
                        if (response.message.reasoningContent) {
                            emit({ type: 'reasoning', delta: response.message.reasoningContent });
                        }
                        if (content) emit({ type: 'assistant', content });
                    }
                    if (!content.trim() && calls.length === 0 && iteration < maxIterations - 1) {
                        maxTokens = Math.min(8192, maxTokens * 2);
                        emit({ type: 'error', message: '模型没有返回工具调用，正在要求它明确结束本轮决策' });
                        messages.push({
                            role: 'user',
                            content: '你上一条回复为空。现在必须调用 decision_finish；不要只返回普通文本。',
                        });
                        continue;
                    }
                    messages.push({
                        role: 'assistant',
                        content: content || null,
                        ...(calls.length > 0 ? { tool_calls: calls } : {}),
                    });
                    if (calls.length === 0) break;

                    for (const call of calls) {
                        if (toolCalls >= maxToolCalls) {
                            emit({ type: 'error', message: `工具调用次数已达到上限 ${maxToolCalls}` });
                            finished = true;
                            break;
                        }
                        toolCalls += 1;
                        let parsed: unknown = {};
                        try {
                            parsed = call.function.arguments ? JSON.parse(call.function.arguments) : {};
                        } catch {
                            parsed = {};
                        }
                        emit({ type: 'tool_call', id: call.id, name: call.function.name, args: parsed });
                        const executed = executeTool(call.function.name, parsed, input);
                        emit({
                            type: 'tool_result',
                            id: call.id,
                            name: call.function.name,
                            result: executed.result,
                        });
                        messages.push({
                            role: 'tool',
                            tool_call_id: call.id,
                            content: JSON.stringify(executed.result),
                        });
                        if (executed.finish != null) {
                            emit({ type: 'finish', summary: executed.finish });
                            finished = true;
                            break;
                        }
                    }
                }
            } catch (error) {
                if (options.signal?.aborted) throw error;
                emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
            }
            return [];
        },
    };
}

export function createOpenAiCompatibleClient(options: {
    baseURL: string;
    apiKey: string;
}): ChatClient {
    const base = options.baseURL.replace(/\/+$/, '');
    return {
        async chat(request, signal) {
            const res = await fetch(`${base}/chat/completions`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${options.apiKey}`,
                },
                body: JSON.stringify(request),
                ...(signal ? { signal } : {}),
            });
            if (!res.ok) {
                const detail = (await res.text()).slice(0, 800);
                throw new Error(`LLM HTTP ${res.status}: ${detail}`);
            }
            const payload = (await res.json()) as {
                choices?: Array<{
                    message?: {
                        content?: string | null;
                        reasoning_content?: string | null;
                        tool_calls?: ChatToolCall[];
                    };
                    finish_reason?: string;
                }>;
                usage?: ChatUsage;
            };
            const choice = payload.choices?.[0];
            const message = choice?.message;
            if (!message) throw new Error('LLM response had no choices[0].message');
            return {
                message: {
                    content: message.content ?? null,
                    ...(message.reasoning_content ? { reasoningContent: message.reasoning_content } : {}),
                    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
                },
                ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}),
                ...(payload.usage ? { usage: payload.usage } : {}),
            };
        },
        async chatStream(request, signal, onEvent) {
            const res = await fetch(`${base}/chat/completions`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${options.apiKey}`,
                },
                body: JSON.stringify({ ...request, stream: true }),
                ...(signal ? { signal } : {}),
            });
            if (!res.ok) {
                const detail = (await res.text()).slice(0, 800);
                throw new Error(`LLM HTTP ${res.status}: ${detail}`);
            }
            if (!res.body) throw new Error('LLM streaming response had no body');

            let content = '';
            let finishReason: string | undefined;
            let usage: ChatUsage | undefined;
            const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            const processLine = (rawLine: string): void => {
                const line = rawLine.trim();
                if (!line.startsWith('data:')) return;
                const data = line.slice(5).trim();
                if (!data || data === '[DONE]') return;
                let payload: {
                    choices?: Array<{
                        delta?: {
                            content?: string | null;
                            reasoning_content?: string | null;
                            tool_calls?: Array<{
                                index?: number;
                                id?: string;
                                function?: { name?: string; arguments?: string };
                            }>;
                        };
                        finish_reason?: string;
                    }>;
                    usage?: ChatUsage;
                };
                try {
                    payload = JSON.parse(data);
                } catch {
                    return;
                }
                if (payload.usage) usage = payload.usage;
                const choice = payload.choices?.[0];
                if (!choice) return;
                if (choice.finish_reason) finishReason = choice.finish_reason;
                const delta = choice.delta;
                if (!delta) return;
                if (delta.reasoning_content) onEvent({ type: 'reasoning', delta: delta.reasoning_content });
                if (delta.content) {
                    content += delta.content;
                    onEvent({ type: 'content', delta: delta.content });
                }
                for (const call of delta.tool_calls ?? []) {
                    const index = call.index ?? 0;
                    const current = toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
                    if (call.id) current.id = call.id;
                    if (call.function?.name) current.name += call.function.name;
                    if (call.function?.arguments) current.arguments += call.function.arguments;
                    toolCalls.set(index, current);
                    onEvent({
                        type: 'tool_call_delta',
                        index,
                        ...(call.id ? { id: call.id } : {}),
                        ...(call.function?.name ? { name: call.function.name } : {}),
                        ...(call.function?.arguments ? { argumentsDelta: call.function.arguments } : {}),
                    });
                }
            };

            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let cut;
                while ((cut = buffer.indexOf('\n')) >= 0) {
                    const line = buffer.slice(0, cut);
                    buffer = buffer.slice(cut + 1);
                    processLine(line);
                }
            }
            if (buffer) processLine(buffer);

            const merged = [...toolCalls.entries()]
                .sort(([a], [b]) => a - b)
                .map(([index, call]) => ({
                    id: call.id || `call_${index}`,
                    type: 'function' as const,
                    function: { name: call.name, arguments: call.arguments || '{}' },
                }));
            return {
                message: {
                    content: content || null,
                    ...(merged.length > 0 ? { tool_calls: merged } : {}),
                },
                ...(finishReason ? { finishReason } : {}),
                ...(usage ? { usage } : {}),
            };
        },
    };
}
