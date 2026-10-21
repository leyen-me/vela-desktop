import { DomainError } from './errors.ts';
import { Ledger } from './ledger.ts';
import { EntryQuota } from './quota.ts';
import { resolveConfig, type ResolvedConfig } from './risk.ts';
import { buildTradingDayPlan, timeframeMs } from './session.ts';
import { SimBroker } from './sim-broker.ts';
import type {
    BacktestAgent,
    BacktestConfig,
    BacktestMetrics,
    BacktestReport,
    Bar,
    BlockedOrder,
    EquityPoint,
    SessionOptions,
    ToolErrorCode,
} from './types.ts';

export interface BacktestInput {
    config: BacktestConfig;
    bars: readonly Bar[];
    agent: BacktestAgent;
    session?: Omit<SessionOptions, 'date' | 'timeframe'>;
    signal?: AbortSignal;
    stopSignal?: AbortSignal;
    waitIfPaused?: () => Promise<void>;
}

function assertBars(bars: readonly Bar[], symbol: string, timeframe: BacktestConfig['timeframe']): void {
    for (const bar of bars) {
        if (bar.symbol !== symbol) {
            throw new DomainError('VALIDATION_ERROR', `Unexpected symbol ${bar.symbol}, expected ${symbol}`);
        }
        if (bar.timeframe !== timeframe) {
            throw new DomainError(
                'VALIDATION_ERROR',
                `Unexpected timeframe ${bar.timeframe}, expected ${timeframe}`,
            );
        }
        if (bar.closeTime <= bar.openTime) {
            throw new DomainError('VALIDATION_ERROR', 'Bar closeTime must be after openTime');
        }
        if (![bar.open, bar.high, bar.low, bar.close].every((value) => Number.isFinite(value) && value > 0)) {
            throw new DomainError('VALIDATION_ERROR', 'Bar prices must be positive finite numbers');
        }
        if (bar.high < bar.low) {
            throw new DomainError('VALIDATION_ERROR', 'Bar high must be >= low');
        }
    }
}

function buildMetrics(
    initialCapital: number,
    finalEquity: number,
    curve: readonly EquityPoint[],
    closedTrades: readonly { pnl: number }[],
    feesPaid: number,
    entriesUsed: number,
    entryLimit: number,
): BacktestMetrics {
    let peak = initialCapital;
    let maxDrawdown = 0;
    let maxDrawdownPct = 0;
    for (const point of curve) {
        if (point.equity > peak) peak = point.equity;
        const drawdown = peak - point.equity;
        if (drawdown > maxDrawdown) {
            maxDrawdown = drawdown;
            maxDrawdownPct = peak > 0 ? (drawdown / peak) * 100 : 0;
        }
    }

    let winCount = 0;
    let lossCount = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    for (const trade of closedTrades) {
        if (trade.pnl > 0) {
            winCount += 1;
            grossProfit += trade.pnl;
        } else if (trade.pnl < 0) {
            lossCount += 1;
            grossLoss += Math.abs(trade.pnl);
        }
    }
    const tradeCount = closedTrades.length;
    const netPnl = finalEquity - initialCapital;

    return {
        initialCapital,
        finalEquity,
        netPnl,
        returnPct: initialCapital > 0 ? (netPnl / initialCapital) * 100 : 0,
        maxDrawdown,
        maxDrawdownPct,
        tradeCount,
        winCount,
        lossCount,
        winRate: tradeCount > 0 ? (winCount / tradeCount) * 100 : 0,
        grossProfit,
        grossLoss,
        profitFactor: grossLoss > 0 ? grossProfit / grossLoss : 0,
        feesPaid,
        entriesUsed,
        entryLimit,
    };
}

export async function runBacktest(input: BacktestInput): Promise<BacktestReport> {
    const config = resolveConfig(input.config);
    const plan = buildTradingDayPlan({
        ...input.session,
        date: config.date,
        timeframe: config.timeframe,
    });
    if (!plan.isTradingDay) {
        throw new DomainError('MARKET_CLOSED', `${config.date} is not a trading day`);
    }

    const tf = timeframeMs(config.timeframe);
    const allBars = [...input.bars].sort((a, b) => a.closeTime - b.closeTime);
    assertBars(allBars, config.symbol, config.timeframe);

    const sessionBars = allBars.filter(
        (bar) => bar.closeTime > plan.open && bar.closeTime <= plan.close,
    );
    if (sessionBars.length === 0) {
        throw new DomainError('VALIDATION_ERROR', `No bars for ${config.date} in the selected session`);
    }
    const first = sessionBars[0] as Bar;
    const last = sessionBars[sessionBars.length - 1] as Bar;
    if (first.openTime !== plan.open) {
        throw new DomainError('VALIDATION_ERROR', 'First session bar does not open at the session open', {
            details: { expected: plan.open, actual: first.openTime },
        });
    }
    if (last.closeTime !== plan.close) {
        throw new DomainError('VALIDATION_ERROR', 'Last session bar does not close at the session close', {
            details: { expected: plan.close, actual: last.closeTime, hint: 'Check half-day close' },
        });
    }
    if (last.openTime - first.openTime > (plan.close - plan.open) + tf) {
        throw new DomainError('VALIDATION_ERROR', 'Unexpected session bar range');
    }

    const ledger = new Ledger(config.initialCapital);
    const quota = new EntryQuota(config.maxEntriesPerDay);
    const broker = new SimBroker({ session: plan, config, ledger, quota });
    const decisions: BacktestReport['decisions'] = [];
    const blockedOrders: BlockedOrder[] = [];
    const equityCurve: EquityPoint[] = [];
    let flattened = false;
    let stopped = false;
    let lastBar: Bar = first;
    let lastKnownPrice = first.open;
    broker.setPrice(config.symbol, lastKnownPrice);

    for (const bar of sessionBars) {
        await input.waitIfPaused?.();
        if (input.signal?.aborted) throw new DOMException('Backtest aborted', 'AbortError');
        if (input.stopSignal?.aborted) {
            stopped = true;
            break;
        }
        lastBar = bar;
        broker.onBar(bar);
        lastKnownPrice = bar.open;

        if (!flattened && bar.openTime >= plan.flattenAt) {
            broker.flatten(lastKnownPrice, plan.flattenAt);
            flattened = true;
        } else if (!flattened && bar.openTime < plan.flattenAt && bar.closeTime > plan.flattenAt) {
            broker.flatten(bar.open, plan.flattenAt);
            flattened = true;
        }

        broker.mark(bar);
        lastKnownPrice = bar.close;
        const account = broker.account;
        const position = ledger.position(config.symbol);
        equityCurve.push({
            time: bar.closeTime,
            equity: account.equity,
            cash: account.cash,
            positionQty: position?.qty ?? 0,
            price: bar.close,
        });

        if (flattened || bar.closeTime >= plan.flattenAt) continue;
        if (!plan.decisionTimes.includes(bar.closeTime)) continue;

        const closedBars = allBars.filter((item) => item.closeTime <= bar.closeTime);
        const tools = {
            asOf: bar.closeTime,
            bars: () => closedBars,
            snapshot: () => ({
                account: broker.account,
                position: ledger.position(config.symbol),
                orders: broker.workingOrders(),
                entryQuota: quota.snapshot(),
            }),
            submitOrder: (request: Parameters<SimBroker['submit']>[0]) =>
                broker.submit(request, bar.closeTime),
            cancelOrder: (orderId: string) => broker.cancel(orderId, bar.closeTime),
            amendOrder: (
                orderId: string,
                patch: { qty?: number; limitPrice?: number; triggerPrice?: number },
            ) => broker.amend(orderId, patch, bar.closeTime),
            closePosition: (options: { kind: 'market' | 'limit'; limitPrice?: number; qty?: number }) =>
                broker.closePosition({ ...options, now: bar.closeTime }),
        };
        await input.waitIfPaused?.();
        if (input.signal?.aborted) throw new DOMException('Backtest aborted', 'AbortError');
        if (input.stopSignal?.aborted) {
            stopped = true;
            break;
        }
        let requested: readonly import('./types.ts').OrderRequest[];
        try {
            requested = await input.agent.decide({
            asOf: bar.closeTime,
            session: plan,
            bars: closedBars,
            account,
            position: position ? { ...position } : null,
            orders: broker.workingOrders(),
            entryQuota: quota.snapshot(),
                lastPrice: bar.close,
                limits: {
                    positionSizePct: config.positionSizePct,
                    maxEntryQtyLong: Math.max(
                        0,
                        Math.floor(
                            (Math.min(
                                (account.equity * config.positionSizePct) / 100,
                                account.buyingPower,
                            )) /
                                bar.close,
                        ),
                    ),
                    maxEntryQtyShort: Math.max(
                        0,
                        Math.floor(((account.equity * config.positionSizePct) / 100) / bar.close),
                    ),
                    maxEntryNotional: (account.equity * config.positionSizePct) / 100,
                },
                tools,
            });
        } catch (error) {
            if (input.stopSignal?.aborted) {
                stopped = true;
                break;
            }
            throw error;
        }
        decisions.push({ asOf: bar.closeTime, orders: requested });
        for (const request of requested) {
            const result = broker.submit(request, bar.closeTime);
            if (!result.ok) {
                blockedOrders.push({
                    at: bar.closeTime,
                    request,
                    code: result.error.code as ToolErrorCode,
                    message: result.error.message,
                });
            }
        }
    }

    const stopTime = stopped ? lastBar.closeTime : plan.flattenAt;
    if (!flattened && lastKnownPrice > 0) {
        broker.flatten(lastKnownPrice, stopTime);
        flattened = true;
    }
    broker.expireWorking(stopped ? stopTime : plan.close);

    const finalAccount = broker.account;
    if (stopped && equityCurve.length > 0) {
        const lastPoint = equityCurve[equityCurve.length - 1];
        if (lastPoint && lastPoint.time !== stopTime) {
            equityCurve.push({
                time: stopTime,
                equity: finalAccount.equity,
                cash: finalAccount.cash,
                positionQty: 0,
                price: lastKnownPrice,
            });
        }
    }
    const closedTrades = ledger.closedTrades;
    const metrics = buildMetrics(
        config.initialCapital,
        finalAccount.equity,
        equityCurve,
        closedTrades,
        ledger.feesPaid,
        quota.used,
        quota.limit,
    );

    return {
        config: {
            symbol: config.symbol,
            date: config.date,
            timeframe: config.timeframe,
            initialCapital: config.initialCapital,
            positionSizePct: config.positionSizePct,
            maxEntriesPerDay: config.maxEntriesPerDay,
            allowShort: config.allowShort,
            allowAddOn: config.allowAddOn,
            slippageBps: config.slippageBps,
            commissionPerShare: config.commissionPerShare,
            commissionBps: config.commissionBps,
        },
        session: plan,
        decisions,
        orders: [...broker.orders],
        fills: [...broker.fills],
        closedTrades: [...closedTrades],
        equityCurve,
        blockedOrders,
        finalAccount,
        metrics,
        stopped,
        ...(stopped ? { stoppedAt: stopTime } : {}),
    };
}

export function createScriptedAgent(
    handler: BacktestAgent['decide'],
): BacktestAgent {
    return { decide: handler };
}

export function makeBar(
    symbol: string,
    timeframe: BacktestConfig['timeframe'],
    openTime: number,
    open: number,
    high: number,
    low: number,
    close: number,
    volume = 0,
): Bar {
    return {
        symbol,
        timeframe,
        openTime,
        closeTime: openTime + timeframeMs(timeframe),
        open,
        high,
        low,
        close,
        volume,
    };
}

export type { ResolvedConfig };
