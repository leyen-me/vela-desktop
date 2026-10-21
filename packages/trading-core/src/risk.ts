import { DomainError } from './errors.ts';
import type {
    AccountSnapshot,
    BacktestConfig,
    OrderRequest,
    Position,
    TradingDayPlan,
} from './types.ts';

export interface ResolvedConfig {
    symbol: string;
    date: string;
    timeframe: BacktestConfig['timeframe'];
    initialCapital: number;
    positionSizePct: number;
    maxEntriesPerDay: number;
    allowShort: boolean;
    allowAddOn: boolean;
    slippageBps: number;
    commissionPerShare: number;
    commissionBps: number;
    idPrefix: string;
}

export function resolveConfig(config: BacktestConfig): ResolvedConfig {
    const initialCapital = config.initialCapital ?? 100_000;
    const positionSizePct = config.positionSizePct ?? 80;
    const maxEntriesPerDay = config.maxEntriesPerDay ?? 2;
    const slippageBps = config.slippageBps ?? 2;
    const commissionPerShare = config.commissionPerShare ?? 0;
    const commissionBps = config.commissionBps ?? 0;

    if (!config.symbol) throw new DomainError('VALIDATION_ERROR', 'symbol is required');
    if (initialCapital <= 0) throw new DomainError('VALIDATION_ERROR', 'initialCapital must be positive');
    if (!(positionSizePct > 0 && positionSizePct <= 100)) {
        throw new DomainError('VALIDATION_ERROR', 'positionSizePct must be within (0, 100]');
    }
    if (!Number.isInteger(maxEntriesPerDay) || maxEntriesPerDay < 0) {
        throw new DomainError('VALIDATION_ERROR', 'maxEntriesPerDay must be a non-negative integer');
    }
    if (slippageBps < 0 || commissionPerShare < 0 || commissionBps < 0) {
        throw new DomainError('VALIDATION_ERROR', 'slippage and commissions cannot be negative');
    }

    return {
        symbol: config.symbol,
        date: config.date,
        timeframe: config.timeframe,
        initialCapital,
        positionSizePct,
        maxEntriesPerDay,
        allowShort: config.allowShort ?? true,
        allowAddOn: config.allowAddOn ?? false,
        slippageBps,
        commissionPerShare,
        commissionBps,
        idPrefix: config.idPrefix ?? `bt-${config.date}-${config.symbol}`,
    };
}

export function assertEntryWindow(session: TradingDayPlan, now: number): void {
    if (!session.isTradingDay) {
        throw new DomainError('MARKET_CLOSED', `${session.date} is not a trading day`);
    }
    if (now < session.open) {
        throw new DomainError('MARKET_CLOSED', 'Session has not opened yet', {
            suggestedAction: 'wait',
            details: { open: session.open, now },
        });
    }
    if (now >= session.flattenAt) {
        throw new DomainError('SESSION_CLOSING', 'Entries are closed for this session', {
            suggestedAction: 'manage_existing',
            details: { flattenAt: session.flattenAt, now },
        });
    }
}

export function assertCloseWindow(session: TradingDayPlan, now: number): void {
    if (!session.isTradingDay) {
        throw new DomainError('MARKET_CLOSED', `${session.date} is not a trading day`);
    }
    if (now < session.open || now > session.close) {
        throw new DomainError('MARKET_CLOSED', 'Session is not open', {
            details: { open: session.open, close: session.close, now },
        });
    }
}

export function assertSymbol(requested: string, configured: string): void {
    if (requested !== configured) {
        throw new DomainError('SYMBOL_NOT_ALLOWED', `This run only trades ${configured}`, {
            details: { requested, configured },
        });
    }
}

export function referencePrice(request: OrderRequest, lastPrice: number): number {
    const price = request.limitPrice ?? request.triggerPrice ?? lastPrice;
    if (!Number.isFinite(price) || price <= 0) {
        throw new DomainError('PRICE_OUT_OF_BAND', 'A positive reference price is required');
    }
    return price;
}

export function resolveEntryQty(
    request: OrderRequest,
    account: AccountSnapshot,
    lastPrice: number,
    config: ResolvedConfig,
    side: 'buy' | 'sell',
): number {
    const price = referencePrice(request, lastPrice);
    const equityCap = (account.equity * config.positionSizePct) / 100;
    const cashCap = side === 'buy' ? account.buyingPower : Number.POSITIVE_INFINITY;
    const cap = Math.min(equityCap, cashCap);
    const maxQty = Math.floor(cap / price);
    const qty = request.qty ?? maxQty;

    if (!Number.isInteger(qty) || qty <= 0) {
        throw new DomainError('INSUFFICIENT_BUYING_POWER', 'Position size is smaller than one share', {
            details: { equity: account.equity, price, positionSizePct: config.positionSizePct },
        });
    }
    if (qty > maxQty) {
        throw new DomainError(
            'RISK_LIMIT_EXCEEDED',
            `Order qty ${qty} exceeds the configured maximum of ${maxQty} shares (${config.positionSizePct}% of equity)`,
            {
                details: { qty, maxQty, positionSizePct: config.positionSizePct, price },
                suggestedAction: 'amend',
            },
        );
    }
    return qty;
}
