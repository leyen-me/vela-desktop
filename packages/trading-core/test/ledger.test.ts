import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.ts';
import type { Fill } from '../src/types.ts';

function fill(
    side: 'buy' | 'sell',
    qty: number,
    price: number,
    fee = 0,
    time = 1,
): Fill {
    return {
        orderId: `o-${time}-${side}`,
        symbol: 'AAPL.US',
        side,
        kind: 'market',
        qty,
        price,
        fee,
        time,
        entry: true,
    };
}

test('long round trip realizes pnl and records a trade', () => {
    const ledger = new Ledger(100_000);
    ledger.applyFill(fill('buy', 100, 100));
    ledger.applyFill(fill('sell', 100, 110, 0, 2));
    assert.equal(ledger.cash, 101_000);
    assert.equal(ledger.realizedPnl, 1_000);
    assert.equal(ledger.closedTrades.length, 1);
    assert.equal(ledger.closedTrades[0]?.pnl, 1_000);
    assert.equal(ledger.closedTrades[0]?.side, 'long');
    assert.equal(ledger.position('AAPL.US')?.qty, 0);
});

test('short round trip realizes pnl', () => {
    const ledger = new Ledger(100_000);
    ledger.applyFill(fill('sell', 100, 100));
    ledger.applyFill(fill('buy', 100, 90, 0, 2));
    assert.equal(ledger.cash, 101_000);
    assert.equal(ledger.realizedPnl, 1_000);
    assert.equal(ledger.closedTrades[0]?.side, 'short');
    assert.equal(ledger.closedTrades[0]?.pnl, 1_000);
});

test('fees are charged on both sides', () => {
    const ledger = new Ledger(100_000);
    ledger.applyFill(fill('buy', 10, 100, 1));
    ledger.applyFill(fill('sell', 10, 110, 1, 2));
    assert.equal(ledger.cash, 100_098);
    assert.equal(ledger.feesPaid, 2);
    assert.equal(ledger.closedTrades[0]?.fees, 2);
});

test('equity and unrealized pnl mark to market', () => {
    const ledger = new Ledger(100_000);
    ledger.applyFill(fill('buy', 100, 100));
    const snapshot = ledger.markToMarket(new Map([['AAPL.US', 105]]));
    assert.equal(snapshot.equity, 100_500);
    assert.equal(snapshot.unrealizedPnl, 500);
    assert.equal(snapshot.positions[0]?.qty, 100);
});
