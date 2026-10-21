import type { AccountSnapshot, ClosedTrade, Fill, Position } from './types.ts';

export class Ledger {
    readonly initialCapital: number;
    private cashAmount: number;
    private realized = 0;
    private fees = 0;
    private readonly book = new Map<string, Position>();
    private readonly closed: ClosedTrade[] = [];

    constructor(initialCapital: number) {
        if (!Number.isFinite(initialCapital) || initialCapital <= 0) {
            throw new Error(`Initial capital must be positive, got ${initialCapital}`);
        }
        this.initialCapital = initialCapital;
        this.cashAmount = initialCapital;
    }

    get cash(): number {
        return this.cashAmount;
    }

    get realizedPnl(): number {
        return this.realized;
    }

    get feesPaid(): number {
        return this.fees;
    }

    get closedTrades(): readonly ClosedTrade[] {
        return this.closed;
    }

    position(symbol: string): Position | null {
        return this.book.get(symbol) ?? null;
    }

    positions(): Position[] {
        return [...this.book.values()];
    }

    applyFill(fill: Fill): void {
        const signed = fill.side === 'buy' ? fill.qty : -fill.qty;
        this.cashAmount -= signed * fill.price;
        this.cashAmount -= fill.fee;
        this.fees += fill.fee;

        const previous = this.book.get(fill.symbol);
        if (!previous) {
            this.book.set(fill.symbol, {
                symbol: fill.symbol,
                qty: signed,
                avgPrice: fill.price,
                openedAt: fill.time,
                realizedPnl: 0,
                entryFee: fill.fee,
            });
            return;
        }

        const previousQty = previous.qty;
        if (previousQty === 0) {
            previous.qty = signed;
            previous.avgPrice = fill.price;
            previous.openedAt = fill.time;
            previous.entryFee = fill.fee;
            return;
        }

        const sameDirection = Math.sign(previousQty) === Math.sign(signed);
        if (sameDirection) {
            const totalQty = Math.abs(previousQty) + fill.qty;
            previous.avgPrice =
                (previous.avgPrice * Math.abs(previousQty) + fill.price * fill.qty) / totalQty;
            previous.qty += signed;
            previous.entryFee += fill.fee;
            return;
        }

        const closeQty = Math.min(Math.abs(previousQty), fill.qty);
        const direction = Math.sign(previousQty);
        const pnl = (fill.price - previous.avgPrice) * closeQty * direction;
        const entryFeePortion =
            Math.abs(previousQty) > 0 ? (previous.entryFee * closeQty) / Math.abs(previousQty) : 0;
        const exitFeePortion = fill.qty > 0 ? (fill.fee * closeQty) / fill.qty : 0;

        this.realized += pnl;
        previous.realizedPnl += pnl;
        previous.entryFee -= entryFeePortion;
        this.closed.push({
            symbol: fill.symbol,
            side: direction > 0 ? 'long' : 'short',
            qty: closeQty,
            entryTime: previous.openedAt ?? fill.time,
            exitTime: fill.time,
            entryPrice: previous.avgPrice,
            exitPrice: fill.price,
            pnl,
            fees: entryFeePortion + exitFeePortion,
        });

        const remaining = fill.qty - closeQty;
        if (remaining > 0) {
            previous.qty = remaining * Math.sign(signed);
            previous.avgPrice = fill.price;
            previous.openedAt = fill.time;
            previous.entryFee = fill.fee - exitFeePortion;
            return;
        }

        previous.qty += signed;
        if (previous.qty === 0) {
            previous.avgPrice = 0;
            previous.openedAt = null;
            previous.entryFee = 0;
        }
    }

    markToMarket(prices: ReadonlyMap<string, number>): AccountSnapshot {
        let positionValue = 0;
        let unrealized = 0;
        const positions: Position[] = [];
        for (const position of this.book.values()) {
            const price = prices.get(position.symbol) ?? position.avgPrice;
            positionValue += position.qty * price;
            unrealized += (price - position.avgPrice) * position.qty;
            if (position.qty !== 0) positions.push({ ...position });
        }
        const equity = this.cashAmount + positionValue;
        return {
            cash: this.cashAmount,
            equity,
            buyingPower: Math.max(0, this.cashAmount),
            realizedPnl: this.realized,
            unrealizedPnl: unrealized,
            feesPaid: this.fees,
            positions,
        };
    }
}
