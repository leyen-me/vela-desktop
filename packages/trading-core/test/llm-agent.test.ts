import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBar, runBacktest } from '../src/backtest.ts';
import { buildTradingDayPlan } from '../src/session.ts';
import {
    createLlmBacktestAgent,
    type ChatClient,
    type ChatRequest,
    type LlmAgentEvent,
} from '../src/llm-agent.ts';
import type { Bar } from '../src/types.ts';

const SYMBOL = 'AAPL.US';
const DATE = '2026-10-20';
const MINUTE = 60_000;

function bars(): Bar[] {
    const plan = buildTradingDayPlan({ date: DATE, timeframe: '5m' });
    const out: Bar[] = [];
    const count = Math.floor((plan.close - plan.open) / (5 * MINUTE));
    for (let index = 0; index < count; index += 1) {
        const price = 100 + index * 0.01;
        out.push(makeBar(SYMBOL, '5m', plan.open + index * 5 * MINUTE, price, price + 0.5, price - 0.5, price, 1000));
    }
    return out;
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
    return {
        id,
        type: 'function' as const,
        function: { name, arguments: JSON.stringify(args) },
    };
}

test('LLM agent executes order tools and finish', async () => {
    const requests: ChatRequest[] = [];
    let calls = 0;
    const client: ChatClient = {
        async chat(request) {
            requests.push(request);
            calls += 1;
            if (calls > 1) return { message: { content: 'No new setup.' } };
            return {
                message: {
                    content: '',
                    tool_calls: [
                        toolCall('c1', 'order_place_market', { side: 'buy', qty: 10 }),
                        toolCall('c2', 'decision_finish', { summary: 'bought' }),
                    ],
                },
                usage: { total_tokens: 10 },
            };
        },
    };
    const agent = createLlmBacktestAgent({ client, model: 'fake', onEvent: () => {} });
    const report = await runBacktest({
        config: {
            symbol: SYMBOL,
            date: DATE,
            timeframe: '5m',
            initialCapital: 100_000,
            positionSizePct: 10,
            maxEntriesPerDay: 2,
            slippageBps: 0,
        },
        bars: bars(),
        agent,
    });

    assert.equal(requests.length, 76);
    assert.ok(requests[0]?.tools.some((tool) => tool.function.name === 'order_place_market'));
    assert.match(requests[0]?.messages[0]?.content ?? '', /简体中文/);
    assert.match(requests[0]?.messages[1]?.content ?? '', /maxEntryQtyLong/);
    const buy = report.orders.find((order) => order.kind === 'market' && order.side === 'buy');
    assert.ok(buy);
    assert.equal(buy?.filledQty, 10);
    assert.equal(report.metrics.entriesUsed, 1);
    assert.equal(report.finalAccount.positions[0]?.qty ?? 0, 0);
});

test('LLM agent sees rejected tool results without crashing', async () => {
    const events: LlmAgentEvent[] = [];
    const client: ChatClient = {
        async chat() {
            return {
                message: {
                    content: '',
                    tool_calls: [
                        toolCall('c1', 'order_place_market', { side: 'buy', qty: 100_000 }),
                        toolCall('c2', 'decision_finish', { summary: 'done' }),
                    ],
                },
            };
        },
    };
    const agent = createLlmBacktestAgent({ client, model: 'fake', onEvent: (event) => events.push(event) });
    const report = await runBacktest({
        config: {
            symbol: SYMBOL,
            date: DATE,
            timeframe: '5m',
            initialCapital: 100_000,
            positionSizePct: 10,
            maxEntriesPerDay: 2,
        },
        bars: bars(),
        agent,
    });
    assert.equal(report.blockedOrders.length, 0);
    const rejected = events.find(
        (event) => event.type === 'tool_result' && event.name === 'order_place_market' && !event.result.ok,
    );
    assert.ok(rejected);
    assert.ok(report.orders.every((order) => order.status !== 'filled'));
});

test('LLM agent without tool calls does not trade', async () => {
    const client: ChatClient = {
        async chat() {
            return { message: { content: 'No setup.' } };
        },
    };
    const agent = createLlmBacktestAgent({ client, model: 'fake' });
    const report = await runBacktest({
        config: {
            symbol: SYMBOL,
            date: DATE,
            timeframe: '5m',
            initialCapital: 100_000,
            positionSizePct: 10,
            maxEntriesPerDay: 2,
        },
        bars: bars(),
        agent,
    });
    assert.equal(report.orders.length, 0);
    assert.equal(report.metrics.entriesUsed, 0);
});

test('streaming client surfaces reasoning and content deltas', async () => {
    const events: LlmAgentEvent[] = [];
    const client: ChatClient = {
        async chat() {
            throw new Error('non-streaming path should not be used');
        },
        async chatStream(_request, _signal, onEvent) {
            onEvent({ type: 'reasoning', delta: 'thinking ' });
            onEvent({ type: 'content', delta: 'answer ' });
            return {
                message: {
                    content: 'answer ',
                    tool_calls: [toolCall('c1', 'decision_finish', { summary: 'hold' })],
                },
            };
        },
    };
    const agent = createLlmBacktestAgent({
        client,
        model: 'fake',
        onEvent: (event) => events.push(event),
    });
    await runBacktest({
        config: {
            symbol: SYMBOL,
            date: DATE,
            timeframe: '5m',
            initialCapital: 100_000,
            positionSizePct: 10,
            maxEntriesPerDay: 2,
        },
        bars: bars(),
        agent,
    });
    assert.ok(events.some((event) => event.type === 'reasoning' && event.delta === 'thinking '));
    assert.ok(events.some((event) => event.type === 'content' && event.delta === 'answer '));
    assert.ok(events.some((event) => event.type === 'tool_call' && event.name === 'decision_finish'));
});

test('keeps one conversation across decisions instead of resetting', async () => {
    const requests: ChatRequest[] = [];
    const client: ChatClient = {
        async chat(request) {
            requests.push({ ...request, messages: request.messages.map((message) => ({ ...message })) });
            return {
                message: {
                    content: '继续观察。',
                    tool_calls: [toolCall('c', 'decision_finish', { summary: '观察' })],
                },
            };
        },
    };
    const agent = createLlmBacktestAgent({ client, model: 'fake' });
    await runBacktest({
        config: {
            symbol: SYMBOL,
            date: DATE,
            timeframe: '5m',
            initialCapital: 100_000,
            positionSizePct: 10,
            maxEntriesPerDay: 2,
        },
        bars: bars(),
        agent,
    });
    assert.ok(requests.length > 1);
    const first = requests[0]?.messages ?? [];
    const second = requests[1]?.messages ?? [];
    assert.equal(first.filter((message) => message.role === 'system').length, 1);
    assert.equal(second.filter((message) => message.role === 'system').length, 1);
    assert.ok(second.length > first.length);
    assert.ok(second.some((message) => message.content?.includes('本轮上下文')));
    assert.ok(second.some((message) => message.role === 'tool'));
});
