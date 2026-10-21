import { DomainError } from './errors.ts';
import { Ledger } from './ledger.ts';
import { canAmend, canCancel, isWorking } from './order-state.ts';
import { EntryQuota } from './quota.ts';
import {
    assertCloseWindow,
    assertEntryWindow,
    assertSymbol,
    referencePrice,
    resolveEntryQty,
    type ResolvedConfig,
} from './risk.ts';
import type {
    AccountSnapshot,
    Bar,
    Fill,
    Order,
    OrderRequest,
    ToolResult,
    TradingDayPlan,
} from './types.ts';
import { failure, success } from './errors.ts';

interface SubmitState {
    entry: boolean;
    qty: number;
    reduceOnly: boolean;
}

export interface SimBrokerOptions {
    session: TradingDayPlan;
    config: ResolvedConfig;
    ledger: Ledger;
    quota: EntryQuota;
}

export class SimBroker {
    private readonly session: TradingDayPlan;
    private readonly config: ResolvedConfig;
    private readonly ledger: Ledger;
    private readonly quota: EntryQuota;
    private readonly orderList: Order[] = [];
    private readonly fillList: Fill[] = [];
    private readonly prices = new Map<string, number>();
    private readonly working = new Map<string, Order>();
    private sequence = 0;
    private lastPrice: number;

    constructor(options: SimBrokerOptions) {
        this.session = options.session;
        this.config = options.config;
        this.ledger = options.ledger;
        this.quota = options.quota;
        this.lastPrice = 0;
    }

    get orders(): readonly Order[] {
        return this.orderList;
    }

    get fills(): readonly Fill[] {
        return this.fillList;
    }

    get lastKnownPrice(): number {
        return this.lastPrice;
    }

    get account(): AccountSnapshot {
        return this.ledger.markToMarket(this.prices);
    }

    workingOrders(): Order[] {
        return [...this.working.values()];
    }

    setPrice(symbol: string, price: number): void {
        if (Number.isFinite(price) && price > 0) {
            this.prices.set(symbol, price);
            this.lastPrice = price;
        }
    }

    mark(bar: Bar): void {
        this.setPrice(bar.symbol, bar.close);
    }

    submit(request: OrderRequest, now: number): ToolResult<Order> {
        try {
            const order = this.buildOrder(request, now);
            this.orderList.push(order);
            this.working.set(order.id, order);
            return success('order.place', order, { source: 'sim' });
        } catch (error) {
            if (error instanceof DomainError) {
                return failure('order.place', error.toPayload(), { source: 'sim' });
            }
            return failure(
                'order.place',
                {
                    code: 'INTERNAL',
                    message: error instanceof Error ? error.message : String(error),
                    retryable: false,
                },
                { source: 'sim' },
            );
        }
    }

    private buildOrder(request: OrderRequest, now: number): Order {
        assertSymbol(request.symbol, this.config.symbol);
        if (!Number.isInteger(request.qty ?? 1) || (request.qty != null && request.qty <= 0)) {
            throw new DomainError('INVALID_ORDER', 'qty must be a positive integer');
        }
        if (!['market', 'limit', 'stop_market', 'stop_limit', 'take_profit_limit'].includes(request.kind)) {
            throw new DomainError('UNSUPPORTED_ORDER_KIND', `Unsupported order kind "${request.kind}"`);
        }

        const position = this.ledger.position(this.config.symbol);
        const positionQty = position?.qty ?? 0;
        const sideSign = request.side === 'buy' ? 1 : -1;
        const requestedReduceOnly = request.reduceOnly ?? false;
        const workingEntries = this.workingOrders().filter((order) => order.entry);
        const protectsWorkingEntry = requestedReduceOnly && positionQty === 0 && workingEntries.length > 0;

        if (requestedReduceOnly && positionQty === 0 && !protectsWorkingEntry) {
            throw new DomainError('INSUFFICIENT_POSITION', 'There is no position or working entry order to protect');
        }
        if (requestedReduceOnly && positionQty !== 0 && Math.sign(positionQty) === sideSign) {
            throw new DomainError('INVALID_ORDER', 'reduceOnly order would increase exposure');
        }

        const reduces = positionQty !== 0 && Math.sign(positionQty) !== sideSign;
        const entry = !reduces && !protectsWorkingEntry;

        if (entry) {
            assertEntryWindow(this.session, now);
            if (workingEntries.length > 0) {
                throw new DomainError('INVALID_ORDER', 'Only one entry order can be working at a time', {
                    suggestedAction: 'manage_existing',
                });
            }
            if (positionQty !== 0 && !this.config.allowAddOn) {
                throw new DomainError('INVALID_ORDER', 'Adding to an open position is disabled', {
                    suggestedAction: 'manage_existing',
                });
            }
            if (request.side === 'sell' && positionQty === 0 && !this.config.allowShort) {
                throw new DomainError('INVALID_ORDER', 'Short selling is disabled for this run');
            }
        } else {
            assertCloseWindow(this.session, now);
        }

        this.validatePrices(request);

        const qty = entry
            ? resolveEntryQty(request, this.account, this.lastPrice, this.config, request.side)
            : protectsWorkingEntry
                ? this.resolveProtectionQty(request, workingEntries)
                : this.resolveCloseQty(request, positionQty, now);

        if (entry) this.quota.reserve();

        try {
            const order: Order = {
                id: `${this.config.idPrefix}-ord-${++this.sequence}`,
                clientOrderId: `${this.config.idPrefix}-ord-${this.sequence}`,
                symbol: this.config.symbol,
                side: request.side,
                kind: request.kind,
                qty,
                filledQty: 0,
                tif: request.tif ?? 'day',
                status: 'new',
                entry,
                reduceOnly: requestedReduceOnly || !entry,
                triggered: false,
                quotaReserved: entry,
                quotaConsumed: false,
                submittedAt: now,
                updatedAt: now,
                fee: 0,
                ...(request.limitPrice != null ? { limitPrice: request.limitPrice } : {}),
                ...(request.triggerPrice != null ? { triggerPrice: request.triggerPrice } : {}),
                ...(request.rationale != null ? { rationale: request.rationale } : {}),
            };
            return order;
        } catch (error) {
            if (entry) this.quota.release();
            throw error;
        }
    }

    private validatePrices(request: OrderRequest): void {
        const requirePositive = (value: number | undefined, name: string): void => {
            if (value == null || !Number.isFinite(value) || value <= 0) {
                throw new DomainError('PRICE_OUT_OF_BAND', `${name} must be a positive number`);
            }
        };
        if (request.kind === 'limit' || request.kind === 'take_profit_limit') {
            requirePositive(request.limitPrice, 'limitPrice');
        }
        if (request.kind === 'stop_market') {
            requirePositive(request.triggerPrice, 'triggerPrice');
        }
        if (request.kind === 'stop_limit') {
            requirePositive(request.triggerPrice, 'triggerPrice');
            requirePositive(request.limitPrice, 'limitPrice');
        }
    }

    private resolveCloseQty(request: OrderRequest, positionQty: number, _now: number): number {
        const available = Math.abs(positionQty);
        if (available <= 0) {
            throw new DomainError('INSUFFICIENT_POSITION', 'There is no position to close');
        }
        const qty = request.qty ?? available;
        if (!Number.isInteger(qty) || qty <= 0) {
            throw new DomainError('INVALID_ORDER', 'Close qty must be a positive integer');
        }
        if (qty > available) {
            throw new DomainError('INSUFFICIENT_POSITION', 'Close qty exceeds the available position', {
                details: { qty, available },
            });
        }
        return qty;
    }

    private resolveProtectionQty(request: OrderRequest, workingEntries: Order[]): number {
        const available = workingEntries.reduce((sum, order) => sum + (order.qty - order.filledQty), 0);
        if (available <= 0) {
            throw new DomainError('INSUFFICIENT_POSITION', 'There is no working entry order to protect');
        }
        const qty = request.qty ?? available;
        if (!Number.isInteger(qty) || qty <= 0) {
            throw new DomainError('INVALID_ORDER', 'Protection qty must be a positive integer');
        }
        if (qty > available) {
            throw new DomainError('INSUFFICIENT_POSITION', 'Protection qty exceeds the working entry', {
                details: { qty, available },
            });
        }
        return qty;
    }

    onBar(bar: Bar): void {
        this.setPrice(bar.symbol, bar.open);
        const openOrders = this.workingOrders().sort((a, b) => a.submittedAt - b.submittedAt);
        for (const order of openOrders) {
            if (order.submittedAt > bar.openTime) continue;
            if (!isWorking(order)) continue;
            if (order.reduceOnly) {
                const position = this.ledger.position(this.config.symbol);
                const positionQty = position?.qty ?? 0;
                const sideSign = order.side === 'buy' ? 1 : -1;
                if (positionQty === 0 || Math.sign(positionQty) === sideSign) {
                    this.expireOrder(order, bar.closeTime);
                    continue;
                }
                const available = Math.abs(positionQty);
                if (order.qty - order.filledQty > available) {
                    order.qty = order.filledQty + available;
                }
            }
            const fillPrice = this.entryFillPrice(order, bar);
            if (fillPrice != null) this.fillOrder(order, bar, fillPrice);
        }
        this.setPrice(bar.symbol, bar.close);
    }

    private entryFillPrice(order: Order, bar: Bar): number | null {
        const slippage = this.config.slippageBps / 10_000;
        if (order.kind === 'market') {
            return order.side === 'buy'
                ? bar.open * (1 + slippage)
                : bar.open * (1 - slippage);
        }

        if (order.kind === 'limit' || order.kind === 'take_profit_limit') {
            return this.limitFillPrice(order, bar);
        }

        if (order.kind === 'stop_market') {
            const trigger = order.triggerPrice as number;
            if (order.side === 'buy' && bar.high >= trigger) {
                return Math.max(bar.open, trigger) * (1 + slippage);
            }
            if (order.side === 'sell' && bar.low <= trigger) {
                return Math.min(bar.open, trigger) * (1 - slippage);
            }
            return null;
        }

        if (order.kind === 'stop_limit') {
            const trigger = order.triggerPrice as number;
            const triggered = order.triggered;
            const hit =
                order.side === 'buy' ? bar.high >= trigger : bar.low <= trigger;
            if (!triggered && !hit) return null;
            order.triggered = true;
            return this.limitFillPrice(order, bar);
        }

        return null;
    }

    private limitFillPrice(order: Order, bar: Bar): number | null {
        const limit = order.limitPrice as number;
        if (order.side === 'buy') {
            if (bar.low > limit) return null;
            return Math.min(bar.open, limit);
        }
        if (bar.high < limit) return null;
        return Math.max(bar.open, limit);
    }

    private fillOrder(order: Order, bar: Bar, price: number): void {
        const qty = order.qty - order.filledQty;
        if (qty <= 0) return;
        const fee = this.commission(qty, price);
        order.filledQty = order.qty;
        order.avgFillPrice = price;
        order.status = 'filled';
        order.filledAt = bar.closeTime;
        order.updatedAt = bar.closeTime;
        order.fee += fee;
        if (order.quotaReserved && !order.quotaConsumed) {
            this.quota.consumeReservation();
            order.quotaReserved = false;
            order.quotaConsumed = true;
        }
        this.working.delete(order.id);
        const fill: Fill = {
            orderId: order.id,
            symbol: order.symbol,
            side: order.side,
            kind: order.kind,
            qty,
            price,
            fee,
            time: bar.closeTime,
            barOpenTime: bar.openTime,
            entry: order.entry,
        };
        this.fillList.push(fill);
        this.ledger.applyFill(fill);
        this.setPrice(order.symbol, price);
        if (!order.entry) {
            const position = this.ledger.position(order.symbol);
            if (!position || position.qty === 0) this.expireReduceOnly(bar.closeTime, order.id);
        }
    }

    private commission(qty: number, price: number): number {
        return qty * this.config.commissionPerShare + qty * price * (this.config.commissionBps / 10_000);
    }

    cancel(orderId: string, now: number): ToolResult<Order> {
        try {
            const order = this.requireOrder(orderId);
            if (!canCancel(order)) {
                throw new DomainError('ORDER_NOT_ACTIVE', `Order ${orderId} is ${order.status}`);
            }
            order.status = 'canceled';
            order.updatedAt = now;
            if (order.quotaReserved && !order.quotaConsumed) {
                this.quota.release();
                order.quotaReserved = false;
            }
            this.working.delete(order.id);
            if (order.entry && (this.ledger.position(this.config.symbol)?.qty ?? 0) === 0) {
                const stillHasEntry = this.workingOrders().some((working) => working.entry);
                if (!stillHasEntry) this.expireReduceOnly(now, order.id);
            }
            return success('order.cancel', order, { source: 'sim' });
        } catch (error) {
            return this.failure('order.cancel', error);
        }
    }

    amend(
        orderId: string,
        patch: { qty?: number; limitPrice?: number; triggerPrice?: number },
        now: number,
    ): ToolResult<Order> {
        try {
            const order = this.requireOrder(orderId);
            if (!canAmend(order)) {
                throw new DomainError('ORDER_NOT_ACTIVE', `Order ${orderId} is ${order.status}`);
            }
            if (order.triggered) {
                throw new DomainError('ORDER_NOT_ACTIVE', 'A triggered order cannot be amended');
            }
            if (order.kind === 'market') {
                throw new DomainError('INVALID_ORDER', 'Market orders cannot be amended');
            }
            if (patch.qty != null) {
                if (!Number.isInteger(patch.qty) || patch.qty <= 0) {
                    throw new DomainError('INVALID_ORDER', 'qty must be a positive integer');
                }
                if (order.entry) {
                    const reference = order.limitPrice ?? order.triggerPrice ?? this.lastPrice;
                    const cap = (this.account.equity * this.config.positionSizePct) / 100;
                    if (patch.qty * reference > cap + 1e-9) {
                        throw new DomainError('RISK_LIMIT_EXCEEDED', 'Amended qty exceeds position size', {
                            suggestedAction: 'amend',
                        });
                    }
                }
                order.qty = patch.qty;
            }
            if (patch.limitPrice != null) {
                if (!Number.isFinite(patch.limitPrice) || patch.limitPrice <= 0) {
                    throw new DomainError('PRICE_OUT_OF_BAND', 'limitPrice must be positive');
                }
                order.limitPrice = patch.limitPrice;
            }
            if (patch.triggerPrice != null) {
                if (!Number.isFinite(patch.triggerPrice) || patch.triggerPrice <= 0) {
                    throw new DomainError('PRICE_OUT_OF_BAND', 'triggerPrice must be positive');
                }
                order.triggerPrice = patch.triggerPrice;
            }
            order.updatedAt = now;
            return success('order.amend', order, { source: 'sim' });
        } catch (error) {
            return this.failure('order.amend', error);
        }
    }

    closePosition(
        options: { kind: 'market' | 'limit'; limitPrice?: number; qty?: number; now: number },
    ): ToolResult<Order> {
        const position = this.ledger.position(this.config.symbol);
        if (!position || position.qty === 0) {
            return failure(
                'position.close',
                {
                    code: 'INSUFFICIENT_POSITION',
                    message: 'There is no open position',
                    retryable: false,
                },
                { source: 'sim' },
            );
        }
        for (const working of this.workingOrders()) {
            if (working.reduceOnly) this.expireOrder(working, options.now);
        }
        return this.submit(
            {
                symbol: this.config.symbol,
                side: position.qty > 0 ? 'sell' : 'buy',
                kind: options.kind,
                qty: options.qty ?? Math.abs(position.qty),
                ...(options.limitPrice != null ? { limitPrice: options.limitPrice } : {}),
                reduceOnly: true,
            },
            options.now,
        );
    }

    flatten(price: number, now: number): void {
        this.expireWorking(now);
        const position = this.ledger.position(this.config.symbol);
        if (!position || position.qty === 0) return;
        const side = position.qty > 0 ? 'sell' : 'buy';
        const qty = Math.abs(position.qty);
        const slippage = this.config.slippageBps / 10_000;
        const fillPrice = side === 'sell' ? price * (1 - slippage) : price * (1 + slippage);
        const fee = this.commission(qty, fillPrice);
        const order: Order = {
            id: `${this.config.idPrefix}-flat-${++this.sequence}`,
            clientOrderId: `${this.config.idPrefix}-flat-${this.sequence}`,
            symbol: this.config.symbol,
            side,
            kind: 'market',
            qty,
            filledQty: qty,
            tif: 'day',
            status: 'filled',
            entry: false,
            reduceOnly: true,
            triggered: false,
            quotaReserved: false,
            quotaConsumed: false,
            submittedAt: now,
            updatedAt: now,
            filledAt: now,
            avgFillPrice: fillPrice,
            fee,
            rationale: 'session flatten',
        };
        this.orderList.push(order);
        const fill: Fill = {
            orderId: order.id,
            symbol: order.symbol,
            side,
            kind: 'market',
            qty,
            price: fillPrice,
            fee,
            time: now,
            barOpenTime: now,
            entry: false,
        };
        this.fillList.push(fill);
        this.ledger.applyFill(fill);
        this.setPrice(order.symbol, fillPrice);
    }

    expireWorking(now: number): void {
        for (const order of this.workingOrders()) {
            if (!isWorking(order)) continue;
            this.expireOrder(order, now);
        }
    }

    private expireOrder(order: Order, now: number): void {
        order.status = 'expired';
        order.updatedAt = now;
        if (order.quotaReserved && !order.quotaConsumed) {
            this.quota.release();
            order.quotaReserved = false;
        }
        this.working.delete(order.id);
    }

    private expireReduceOnly(now: number, exceptOrderId: string): void {
        for (const order of this.workingOrders()) {
            if (order.id === exceptOrderId || !order.reduceOnly) continue;
            this.expireOrder(order, now);
        }
    }

    private requireOrder(orderId: string): Order {
        const order = this.orderList.find((item) => item.id === orderId);
        if (!order) throw new DomainError('ORDER_NOT_FOUND', `Order ${orderId} not found`);
        return order;
    }

    private failure(tool: string, error: unknown): ToolResult<never> {
        if (error instanceof DomainError) {
            return failure(tool, error.toPayload(), { source: 'sim' });
        }
        return failure(
            tool,
            {
                code: 'INTERNAL',
                message: error instanceof Error ? error.message : String(error),
                retryable: false,
            },
            { source: 'sim' },
        );
    }
}
