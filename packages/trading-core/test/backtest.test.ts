import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBar, runBacktest } from '../src/backtest.ts';
import { buildTradingDayPlan } from '../src/session.ts';
import type { BacktestAgent, Bar, DecisionInput, OrderRequest } from '../src/types.ts';

const SYMBOL = 'AAPL.US';
const DATE = '2026-10-20';
const MINUTE = 60_000;

function sessionBars(
    close: { hour: number; minute: number } = { hour: 16, minute: 0 },
    priceFor: (index: number) => number = (index) => 100 + index * 0.01,
): Bar[] {
    const plan = buildTradingDayPlan({ date: DATE, timeframe: '5m', close });
    const bars: Bar[] = [];
    const count = Math.floor((plan.close - plan.open) / (5 * MINUTE));
    for (let index = 0; index < count; index += 1) {
        const price = priceFor(index);
        bars.push(makeBar(SYMBOL, '5m', plan.open + index * 5 * MINUTE, price, price + 0.5, price - 0.5, price, 1000));
    }
    return bars;
}

function agentFrom(handler: (input: DecisionInput, index: number) => readonly OrderRequest[]): BacktestAgent {
    let index = 0;
    return {
        decide(input) {
            const result = handler(input, index);
            index += 1;
            return result;
        },
    };
}

test('single day backtest fills next bar, enforces two entries and flattens', async () => {
    const bars = sessionBars();
    const agent = agentFrom((input, index) => {
        if (index === 0) return [{ symbol: SYMBOL, side: 'buy', kind: 'market', qty: 10 }];
        if (index === 1) return [{ symbol: SYMBOL, side: 'sell', kind: 'market', qty: 10, reduceOnly: true }];
        if (index === 2) return [{ symbol: SYMBOL, side: 'buy', kind: 'market', qty: 10 }];
        if (index === 3) return [{ symbol: SYMBOL, side: 'sell', kind: 'market', qty: 10, reduceOnly: true }];
        if (index === 4) return [{ symbol: SYMBOL, side: 'buy', kind: 'market', qty: 10 }];
        return [];
    });

    const report = await runBacktest({
        config: {
            symbol: SYMBOL,
            date: DATE,
            timeframe: '5m',
            initialCapital: 100_000,
            positionSizePct: 10,
            maxEntriesPerDay: 2,
            allowShort: true,
            allowAddOn: false,
            slippageBps: 0,
        },
        bars,
        agent,
    });

    assert.equal(report.session.decisionTimes.length, 76);
    assert.equal(report.decisions.length, 76);
    assert.equal(report.metrics.entriesUsed, 2);
    assert.equal(report.metrics.tradeCount, 2);
    assert.equal(report.blockedOrders.length, 1);
    assert.equal(report.blockedOrders[0]?.code, 'DAILY_ENTRY_LIMIT_REACHED');
    assert.equal(report.finalAccount.positions[0]?.qty ?? 0, 0);
    assert.equal(report.equityCurve.at(-1)?.time, report.session.close);
    assert.ok(report.fills.length >= 4);
});

test('agent only sees bars closed at its asOf time', async () => {
    const bars = sessionBars();
    let checked = 0;
    const agent: BacktestAgent = {
        decide(input) {
            for (const bar of input.bars) {
                assert.ok(bar.closeTime <= input.asOf);
                checked += 1;
            }
            return [];
        },
    };
    const report = await runBacktest({
        config: {
            symbol: SYMBOL,
            date: DATE,
            timeframe: '5m',
            initialCapital: 100_000,
            positionSizePct: 10,
            maxEntriesPerDay: 2,
        },
        bars,
        agent,
    });
    assert.equal(report.decisions.length, 76);
    assert.ok(checked > 0);
});

test('open position is flattened at 15:55 and not carried overnight', async () => {
    const bars = sessionBars();
    const agent = agentFrom((_input, index) =>
        index === 0 ? [{ symbol: SYMBOL, side: 'buy', kind: 'market', qty: 10 }] : [],
    );
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
        bars,
        agent,
    });
    const flattenOrder = report.orders.find((order) => order.rationale === 'session flatten');
    assert.ok(flattenOrder);
    assert.equal(flattenOrder?.filledQty, 10);
    assert.equal(flattenOrder?.submittedAt, report.session.flattenAt);
    assert.equal(report.finalAccount.positions[0]?.qty ?? 0, 0);
    assert.equal(report.metrics.tradeCount, 1);
});

test('half day ends at 13:00 with no decisions after 12:50', async () => {
    const close = { hour: 13, minute: 0 };
    const bars = sessionBars(close);
    const agent = agentFrom((_input, index) =>
        index === 0 ? [{ symbol: SYMBOL, side: 'buy', kind: 'market', qty: 10 }] : [],
    );
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
        bars,
        agent,
        session: { close },
    });
    assert.equal(report.session.isEarlyClose, true);
    assert.equal(report.session.close, Date.UTC(2026, 9, 20, 17, 0));
    assert.equal(report.session.decisionTimes.at(-1), Date.UTC(2026, 9, 20, 16, 50));
    assert.equal(report.equityCurve.at(-1)?.time, report.session.close);
    assert.equal(report.orders.find((order) => order.rationale === 'session flatten')?.submittedAt, Date.UTC(2026, 9, 20, 16, 55));
});

test('missing the session close bar fails instead of silently skipping it', async () => {
    const bars = sessionBars().slice(0, -1);
    await assert.rejects(
        runBacktest({
            config: {
                symbol: SYMBOL,
                date: DATE,
                timeframe: '5m',
                initialCapital: 100_000,
            },
            bars,
            agent: agentFrom(() => []),
        }),
        /Last session bar/,
    );
});

test('non-aligned timeframe still flattens at 15:55 using the last known price', async () => {
    const plan = buildTradingDayPlan({ date: DATE, timeframe: '15m' });
    const out: Bar[] = [];
    const count = Math.floor((plan.close - plan.open) / (15 * MINUTE));
    for (let index = 0; index < count; index += 1) {
        const price = 100 + index * 0.01;
        out.push(makeBar(SYMBOL, '15m', plan.open + index * 15 * MINUTE, price, price + 0.5, price - 0.5, price, 1000));
    }
    const agent = agentFrom((_input, index) =>
        index === 0 ? [{ symbol: SYMBOL, side: 'buy', kind: 'market', qty: 10 }] : [],
    );
    const report = await runBacktest({
        config: {
            symbol: SYMBOL,
            date: DATE,
            timeframe: '15m',
            initialCapital: 100_000,
            positionSizePct: 10,
            maxEntriesPerDay: 2,
            slippageBps: 0,
        },
        bars: out,
        agent,
    });
    const flattenOrder = report.orders.find((order) => order.rationale === 'session flatten');
    assert.equal(flattenOrder?.submittedAt, report.session.flattenAt);
    assert.equal(report.finalAccount.positions[0]?.qty ?? 0, 0);
});

test('does not advance to the next bar until the agent finishes', async () => {
    let calls = 0;
    const gate: { release?: () => void } = {};
    const firstDecision = new Promise<void>((resolve) => {
        gate.release = resolve;
    });
    const agent: BacktestAgent = {
        async decide() {
            calls += 1;
            if (calls === 1) await firstDecision;
            return [];
        },
    };
    const run = runBacktest({
        config: {
            symbol: SYMBOL,
            date: DATE,
            timeframe: '5m',
            initialCapital: 100_000,
            positionSizePct: 10,
            maxEntriesPerDay: 2,
        },
        bars: sessionBars(),
        agent,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls, 1);
    gate.release?.();
    const report = await run;
    assert.equal(calls, 76);
    assert.equal(report.decisions.length, 76);
});

test('pause gate waits between bars without advancing', async () => {
    let calls = 0;
    let waits = 0;
    const gate: { release?: () => void } = {};
    const waitIfPaused = () => {
        waits += 1;
        if (waits === 3) {
            return new Promise<void>((resolve) => {
                gate.release = resolve;
            });
        }
        return Promise.resolve();
    };
    const agent: BacktestAgent = {
        decide() {
            calls += 1;
            return [];
        },
    };
    const run = runBacktest({
        config: {
            symbol: SYMBOL,
            date: DATE,
            timeframe: '5m',
            initialCapital: 100_000,
            positionSizePct: 10,
            maxEntriesPerDay: 2,
        },
        bars: sessionBars(),
        agent,
        waitIfPaused,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls, 1);
    gate.release?.();
    const report = await run;
    assert.equal(calls, 76);
    assert.equal(report.decisions.length, 76);
});

test('soft stop returns a partial report instead of throwing', async () => {
    const controller = new AbortController();
    let calls = 0;
    const agent: BacktestAgent = {
        decide() {
            calls += 1;
            controller.abort();
            return [];
        },
    };
    const report = await runBacktest({
        config: {
            symbol: SYMBOL,
            date: DATE,
            timeframe: '5m',
            initialCapital: 100_000,
            positionSizePct: 10,
            maxEntriesPerDay: 2,
        },
        bars: sessionBars(),
        agent,
        stopSignal: controller.signal,
    });
    assert.equal(report.stopped, true);
    assert.equal(report.decisions.length, 1);
    assert.equal(calls, 1);
    assert.ok(report.stoppedAt != null);
});
