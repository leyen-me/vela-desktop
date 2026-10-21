export type Millis = number;

/** US venue only for now. Kept as a union so other markets can be added without a rewrite. */
export type Market = 'US';

/** Intraday timeframes only. */
export type Timeframe = '1m' | '5m' | '15m' | '30m' | '1h' | '2h' | '4h';

export type Side = 'buy' | 'sell';

export type OrderKind =
    | 'market'
    | 'limit'
    | 'stop_market'
    | 'stop_limit'
    | 'take_profit_limit';

export type TimeInForce = 'day';

export type OrderStatus =
    | 'pending_new'
    | 'new'
    | 'partially_filled'
    | 'filled'
    | 'canceled'
    | 'rejected'
    | 'expired';

/**
 * Canonical bar shape.
 *
 * `closeTime` is the ONLY time the engine reasons about. `openTime` exists for chart
 * adapters and for fill ordering; it is always `closeTime - timeframe`.
 */
export interface Bar {
    symbol: string;
    timeframe: Timeframe;
    openTime: Millis;
    closeTime: Millis;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

/** A wall-clock time inside the session's timezone. */
export interface LocalTime {
    hour: number;
    minute: number;
}

export interface SessionOptions {
    date: string;
    timeframe: Timeframe;
    market?: Market;
    timezone?: string;
    open?: LocalTime;
    /** Supply the early-close time from the venue calendar; defaults to 16:00. */
    close?: LocalTime;
    /** Defaults to 5 minutes before the session close. */
    flattenOffsetMs?: number;
    /** Optional venue holiday set as `YYYY-MM-DD` strings. */
    holidays?: ReadonlySet<string>;
}

export interface TradingDayPlan {
    market: Market;
    date: string;
    timezone: string;
    isTradingDay: boolean;
    /** Epoch ms of the first tradeable bar open. */
    open: Millis;
    /** Epoch ms of the session close. */
    close: Millis;
    /** Epoch ms at which new entries stop and positions are flattened. */
    flattenAt: Millis;
    isEarlyClose: boolean;
    timeframe: Timeframe;
    /** Bar close times at which the agent may make a decision. Always `< flattenAt`. */
    decisionTimes: Millis[];
}

export interface OrderRequest {
    symbol: string;
    side: Side;
    kind: OrderKind;
    /** Omit for a full close, or for an entry sized by the risk engine. */
    qty?: number;
    limitPrice?: number;
    triggerPrice?: number;
    reduceOnly?: boolean;
    tif?: TimeInForce;
    rationale?: string;
}

export interface Order {
    id: string;
    clientOrderId: string;
    symbol: string;
    side: Side;
    kind: OrderKind;
    qty: number;
    filledQty: number;
    limitPrice?: number;
    triggerPrice?: number;
    tif: TimeInForce;
    status: OrderStatus;
    /** True when the order establishes or increases exposure. */
    entry: boolean;
    reduceOnly: boolean;
    triggered: boolean;
    /** Entry quota reserved on submit. */
    quotaReserved: boolean;
    /** Entry quota consumed on the first fill. */
    quotaConsumed: boolean;
    submittedAt: Millis;
    updatedAt: Millis;
    filledAt?: Millis;
    avgFillPrice?: number;
    fee: number;
    rejectReason?: string;
    rationale?: string;
}

export interface Fill {
    orderId: string;
    symbol: string;
    side: Side;
    kind: OrderKind;
    qty: number;
    price: number;
    fee: number;
    time: Millis;
    barOpenTime?: Millis;
    entry: boolean;
}

export interface ClosedTrade {
    symbol: string;
    side: 'long' | 'short';
    qty: number;
    entryTime: Millis;
    exitTime: Millis;
    entryPrice: number;
    exitPrice: number;
    pnl: number;
    fees: number;
}

export interface Position {
    symbol: string;
    /** Signed shares: positive = long, negative = short. */
    qty: number;
    avgPrice: number;
    openedAt: Millis | null;
    realizedPnl: number;
    entryFee: number;
}

export interface AccountSnapshot {
    cash: number;
    equity: number;
    buyingPower: number;
    realizedPnl: number;
    unrealizedPnl: number;
    feesPaid: number;
    positions: Position[];
}

export interface EntryQuotaSnapshot {
    limit: number;
    used: number;
    reserved: number;
    available: number;
}

export interface BacktestConfig {
    symbol: string;
    /** Market-local date, `YYYY-MM-DD`. */
    date: string;
    timeframe: Timeframe;
    initialCapital?: number;
    /** Percent of current equity used for each entry. Default 80. */
    positionSizePct?: number;
    /** Maximum entries per day. Default 2. */
    maxEntriesPerDay?: number;
    allowShort?: boolean;
    allowAddOn?: boolean;
    /** Slippage applied to market/stop-market fills, in basis points. */
    slippageBps?: number;
    commissionPerShare?: number;
    commissionBps?: number;
    idPrefix?: string;
}

export interface ToolHostSnapshot {
    account: AccountSnapshot;
    position: Position | null;
    orders: readonly Order[];
    entryQuota: EntryQuotaSnapshot;
}

export interface BacktestToolHost {
    readonly asOf: Millis;
    bars(): readonly Bar[];
    snapshot(): ToolHostSnapshot;
    submitOrder(request: OrderRequest): ToolResult<Order>;
    cancelOrder(orderId: string): ToolResult<Order>;
    amendOrder(
        orderId: string,
        patch: { qty?: number; limitPrice?: number; triggerPrice?: number },
    ): ToolResult<Order>;
    closePosition(options: { kind: 'market' | 'limit'; limitPrice?: number; qty?: number }): ToolResult<Order>;
}

export interface DecisionInput {
    asOf: Millis;
    session: TradingDayPlan;
    /** All bars whose closeTime is <= asOf, oldest first. Warmup included. */
    bars: readonly Bar[];
    account: AccountSnapshot;
    position: Position | null;
    /** Working orders only. */
    orders: readonly Order[];
    entryQuota: EntryQuotaSnapshot;
    /** Last known close, for sizing. */
    lastPrice: number;
    limits: {
        positionSizePct: number;
        maxEntryQtyLong: number;
        maxEntryQtyShort: number;
        maxEntryNotional: number;
    };
    tools: BacktestToolHost;
}

export type AgentOrders = readonly OrderRequest[];

export interface BacktestAgent {
    decide(input: DecisionInput): AgentOrders | Promise<AgentOrders>;
}

export interface EquityPoint {
    time: Millis;
    equity: number;
    cash: number;
    positionQty: number;
    price: number;
}

export interface BlockedOrder {
    at: Millis;
    request: OrderRequest;
    code: ToolErrorCode;
    message: string;
}

export interface BacktestMetrics {
    initialCapital: number;
    finalEquity: number;
    netPnl: number;
    returnPct: number;
    maxDrawdown: number;
    maxDrawdownPct: number;
    tradeCount: number;
    winCount: number;
    lossCount: number;
    winRate: number;
    grossProfit: number;
    grossLoss: number;
    profitFactor: number;
    feesPaid: number;
    entriesUsed: number;
    entryLimit: number;
}

export interface BacktestReport {
    config: Required<
        Pick<
            BacktestConfig,
            | 'symbol'
            | 'date'
            | 'timeframe'
            | 'initialCapital'
            | 'positionSizePct'
            | 'maxEntriesPerDay'
            | 'allowShort'
            | 'allowAddOn'
            | 'slippageBps'
            | 'commissionPerShare'
            | 'commissionBps'
        >
    >;
    session: TradingDayPlan;
    decisions: Array<{ asOf: Millis; orders: AgentOrders }>;
    orders: Order[];
    fills: Fill[];
    closedTrades: ClosedTrade[];
    equityCurve: EquityPoint[];
    blockedOrders: BlockedOrder[];
    finalAccount: AccountSnapshot;
    metrics: BacktestMetrics;
    stopped: boolean;
    stoppedAt?: Millis;
}

export type ToolErrorCode =
    | 'VALIDATION_ERROR'
    | 'UNKNOWN_TOOL'
    | 'INVALID_ORDER'
    | 'SYMBOL_NOT_ALLOWED'
    | 'MARKET_CLOSED'
    | 'SESSION_CLOSING'
    | 'DAILY_ENTRY_LIMIT_REACHED'
    | 'INSUFFICIENT_BUYING_POWER'
    | 'INSUFFICIENT_POSITION'
    | 'ORDER_NOT_FOUND'
    | 'ORDER_NOT_ACTIVE'
    | 'PRICE_OUT_OF_BAND'
    | 'RISK_LIMIT_EXCEEDED'
    | 'DUPLICATE_ORDER'
    | 'UNSUPPORTED_ORDER_KIND'
    | 'INTERNAL';

export type SuggestedAction = 'retry' | 'refresh' | 'amend' | 'wait' | 'stop' | 'manage_existing';

export interface ToolErrorPayload {
    code: ToolErrorCode;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
    suggestedAction?: SuggestedAction;
}

export interface ToolMeta {
    durationMs?: number;
    source?: 'sim' | 'broker';
    deduped?: boolean;
    [key: string]: unknown;
}

export interface ToolSuccess<T> {
    version: 1;
    ok: true;
    tool: string;
    data: T;
    warnings: string[];
    meta: ToolMeta;
}

export interface ToolFailure {
    version: 1;
    ok: false;
    tool: string;
    error: ToolErrorPayload;
    meta: ToolMeta;
}

export type ToolResult<T> = ToolSuccess<T> | ToolFailure;
