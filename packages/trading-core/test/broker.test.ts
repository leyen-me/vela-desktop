import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.ts';
import { EntryQuota } from '../src/quota.ts';
import { resolveConfig } from '../src/risk.ts';
import { buildTradingDayPlan } from '../src/session.ts';
import { SimBroker } from '../src/sim-broker.ts';
import { makeBar } from '../src/backtest.ts';
import type { BacktestConfig, Bar } from '../src/types.ts';

const SYMBOL = 'AAPL.US';
const DATE = '2026-10-20';
const MINUTE = 60_000;

function setup(overrides: Partial<BacktestConfig> = {}) {
    const plan = buildTradingDayPlan({ date: DATE, timeframe: '5m' });
    const config = resolveConfig({
        symbol: SYMBOL,
        date: DATE,
        timeframe: '5m',
        initialCapital: 100_000,
        positionSizePct: 10,
        maxEntriesPerDay: 2,
        allowShort: true,
        allowAddOn: false,
        slippageBps: 0,
        ...overrides,
    });
    const ledger = new Ledger(config.initialCapital);
    const quota = new EntryQuota(config.maxEntriesPerDay);
    const broker = new SimBroker({ session: plan, config, ledger, quota });
    broker.setPrice(SYMBOL, 100);
    return { plan, config, ledger, quota, broker };
}

function bar(plan: ReturnType<typeof buildTradingDayPlan>, minutes: number, o: number, h: number, l: number, c: number): Bar {
    return makeBar(SYMBOL, '5m', plan.open + minutes * MINUTE, o, h, l, c);
}

test('market entry fills at next bar open and consumes one entry', () => {
    const { plan, ledger, quota, broker } = setup();
    const at = plan.open + 5 * MINUTE;
    const result = broker.submit({ symbol: SYMBOL, side: 'buy', kind: 'market', qty: 10 }, at);
    assert.equal(result.ok, true);
    assert.equal(quota.used, 0);
    assert.equal(quota.reserved, 1);

    broker.onBar(bar(plan, 5, 100, 101, 99, 100.5));
    assert.equal(ledger.position(SYMBOL)?.qty, 10);
    assert.equal(broker.fills[0]?.price, 100);
    assert.equal(quota.used, 1);
    assert.equal(quota.reserved, 0);
});

test('market entry is sized from equity when qty is omitted', () => {
    const { plan, broker } = setup({ positionSizePct: 10 });
    const at = plan.open + 5 * MINUTE;
    const result = broker.submit({ symbol: SYMBOL, side: 'buy', kind: 'market' }, at);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.data.qty, 100);
});

test('limit entry waits for price and can be canceled to release quota', () => {
    const { plan, ledger, quota, broker } = setup();
    const at = plan.open + 5 * MINUTE;
    const result = broker.submit(
        { symbol: SYMBOL, side: 'buy', kind: 'limit', qty: 10, limitPrice: 95 },
        at,
    );
    assert.equal(result.ok, true);
    assert.equal(quota.reserved, 1);

    broker.onBar(bar(plan, 5, 100, 101, 96, 100));
    assert.equal(ledger.position(SYMBOL), null);
    assert.equal(result.ok && result.data.status, 'new');

    if (result.ok) {
        const canceled = broker.cancel(result.data.id, plan.open + 10 * MINUTE);
        assert.equal(canceled.ok, true);
        assert.equal(quota.reserved, 0);
    }
});

test('limit entry fills at the limit or better', () => {
    const { plan, ledger, broker } = setup();
    const at = plan.open + 5 * MINUTE;
    const result = broker.submit(
        { symbol: SYMBOL, side: 'buy', kind: 'limit', qty: 10, limitPrice: 95 },
        at,
    );
    assert.equal(result.ok, true);
    broker.onBar(bar(plan, 5, 94, 96, 93, 95.5));
    assert.equal(ledger.position(SYMBOL)?.qty, 10);
    assert.equal(broker.fills[0]?.price, 94);
});

test('no add-on: a second buy while long is rejected', () => {
    const { plan, broker } = setup();
    const at = plan.open + 5 * MINUTE;
    assert.equal(
        broker.submit({ symbol: SYMBOL, side: 'buy', kind: 'market', qty: 10 }, at).ok,
        true,
    );
    broker.onBar(bar(plan, 5, 100, 101, 99, 100));
    const second = broker.submit({ symbol: SYMBOL, side: 'buy', kind: 'market', qty: 10 }, at + 5 * MINUTE);
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.error.code, 'INVALID_ORDER');
});

test('short entry and close realize pnl', () => {
    const { plan, ledger, broker } = setup();
    const entryAt = plan.open + 5 * MINUTE;
    assert.equal(
        broker.submit({ symbol: SYMBOL, side: 'sell', kind: 'market', qty: 10 }, entryAt).ok,
        true,
    );
    broker.onBar(bar(plan, 5, 100, 101, 99, 100));
    assert.equal(ledger.position(SYMBOL)?.qty, -10);

    const close = broker.closePosition({ kind: 'market', now: plan.open + 10 * MINUTE });
    assert.equal(close.ok, true);
    broker.onBar(bar(plan, 10, 90, 91, 89, 90));
    assert.equal(ledger.position(SYMBOL)?.qty, 0);
    assert.equal(ledger.realizedPnl, 100);
});

test('stop market exit triggers inside the bar', () => {
    const { plan, ledger, broker } = setup();
    const entryAt = plan.open + 5 * MINUTE;
    assert.equal(
        broker.submit({ symbol: SYMBOL, side: 'buy', kind: 'market', qty: 10 }, entryAt).ok,
        true,
    );
    broker.onBar(bar(plan, 5, 100, 101, 99, 100));

    const stop = broker.submit(
        {
            symbol: SYMBOL,
            side: 'sell',
            kind: 'stop_market',
            qty: 10,
            triggerPrice: 95,
            reduceOnly: true,
        },
        plan.open + 10 * MINUTE,
    );
    assert.equal(stop.ok, true);
    broker.onBar(bar(plan, 10, 100, 101, 94, 96));
    assert.equal(ledger.position(SYMBOL)?.qty, 0);
    assert.equal(broker.fills.at(-1)?.price, 95);
});

test('daily entry limit survives close and re-entry', () => {
    const { plan, ledger, quota, broker } = setup();
    const entryAt = plan.open + 5 * MINUTE;
    assert.equal(
        broker.submit({ symbol: SYMBOL, side: 'buy', kind: 'market', qty: 10 }, entryAt).ok,
        true,
    );
    broker.onBar(bar(plan, 5, 100, 101, 99, 100));
    assert.equal(broker.closePosition({ kind: 'market', now: plan.open + 10 * MINUTE }).ok, true);
    broker.onBar(bar(plan, 10, 100, 101, 99, 100));
    assert.equal(ledger.position(SYMBOL)?.qty, 0);

    assert.equal(
        broker.submit({ symbol: SYMBOL, side: 'buy', kind: 'market', qty: 10 }, plan.open + 15 * MINUTE).ok,
        true,
    );
    broker.onBar(bar(plan, 15, 100, 101, 99, 100));
    assert.equal(broker.closePosition({ kind: 'market', now: plan.open + 20 * MINUTE }).ok, true);
    broker.onBar(bar(plan, 20, 100, 101, 99, 100));
    assert.equal(quota.used, 2);

    const third = broker.submit(
        { symbol: SYMBOL, side: 'buy', kind: 'market', qty: 10 },
        plan.open + 25 * MINUTE,
    );
    assert.equal(third.ok, false);
    if (!third.ok) assert.equal(third.error.code, 'DAILY_ENTRY_LIMIT_REACHED');
});

test('entries are rejected after flatten', () => {
    const { plan, broker } = setup();
    const result = broker.submit(
        { symbol: SYMBOL, side: 'buy', kind: 'market', qty: 10 },
        plan.flattenAt,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'SESSION_CLOSING');
});

test('flatten closes any open position and expires working orders', () => {
    const { plan, ledger, broker } = setup();
    const at = plan.open + 5 * MINUTE;
    assert.equal(broker.submit({ symbol: SYMBOL, side: 'buy', kind: 'market', qty: 10 }, at).ok, true);
    broker.onBar(bar(plan, 5, 100, 101, 99, 100));
    broker.submit(
        { symbol: SYMBOL, side: 'buy', kind: 'limit', qty: 10, limitPrice: 90 },
        plan.open + 10 * MINUTE,
    );
    broker.flatten(98, plan.flattenAt);
    assert.equal(ledger.position(SYMBOL)?.qty, 0);
    assert.equal(broker.workingOrders().length, 0);
    assert.ok(broker.orders.some((order) => order.rationale === 'session flatten'));
});

test('protective orders are expired when the position is closed', () => {
    const { plan, ledger, broker } = setup();
    const at = plan.open + 5 * MINUTE;
    assert.equal(broker.submit({ symbol: SYMBOL, side: 'buy', kind: 'market', qty: 10 }, at).ok, true);
    broker.onBar(bar(plan, 5, 100, 101, 99, 100));

    const stop = broker.submit(
        { symbol: SYMBOL, side: 'sell', kind: 'stop_market', qty: 10, triggerPrice: 95, reduceOnly: true },
        plan.open + 10 * MINUTE,
    );
    assert.equal(stop.ok, true);
    assert.equal(broker.closePosition({ kind: 'market', now: plan.open + 10 * MINUTE }).ok, true);
    broker.onBar(bar(plan, 10, 100, 101, 99, 100));
    assert.equal(ledger.position(SYMBOL)?.qty, 0);
    assert.equal(broker.workingOrders().length, 0);
    if (stop.ok) assert.equal(stop.data.status, 'expired');

    broker.onBar(bar(plan, 15, 94, 95, 93, 94));
    assert.equal(ledger.position(SYMBOL)?.qty, 0);
});

test('bracket orders can be placed before the entry fills', () => {
    const { plan, ledger, broker } = setup();
    const at = plan.open + 5 * MINUTE;
    assert.equal(
        broker.submit({ symbol: SYMBOL, side: 'buy', kind: 'limit', qty: 10, limitPrice: 95 }, at).ok,
        true,
    );
    const stop = broker.submit(
        {
            symbol: SYMBOL,
            side: 'sell',
            kind: 'stop_market',
            qty: 10,
            triggerPrice: 90,
            reduceOnly: true,
        },
        at,
    );
    const takeProfit = broker.submit(
        {
            symbol: SYMBOL,
            side: 'sell',
            kind: 'take_profit_limit',
            qty: 10,
            limitPrice: 110,
            reduceOnly: true,
        },
        at,
    );
    assert.equal(stop.ok, true);
    assert.equal(takeProfit.ok, true);
    assert.equal(broker.workingOrders().length, 3);

    broker.onBar(bar(plan, 5, 94, 96, 93, 95));
    assert.equal(ledger.position(SYMBOL)?.qty, 10);
    broker.onBar(bar(plan, 10, 92, 93, 89, 90));
    assert.equal(ledger.position(SYMBOL)?.qty, 0);
    assert.equal(broker.workingOrders().length, 0);
    if (takeProfit.ok) assert.equal(takeProfit.data.status, 'expired');
});

test('canceling the entry also expires its protective orders', () => {
    const { plan, broker } = setup();
    const at = plan.open + 5 * MINUTE;
    const entry = broker.submit(
        { symbol: SYMBOL, side: 'buy', kind: 'limit', qty: 10, limitPrice: 95 },
        at,
    );
    assert.equal(entry.ok, true);
    const stop = broker.submit(
        {
            symbol: SYMBOL,
            side: 'sell',
            kind: 'stop_market',
            qty: 10,
            triggerPrice: 90,
            reduceOnly: true,
        },
        at,
    );
    assert.equal(stop.ok, true);
    if (entry.ok) broker.cancel(entry.data.id, at + MINUTE);
    assert.equal(broker.workingOrders().length, 0);
    if (stop.ok) assert.equal(stop.data.status, 'expired');
});
