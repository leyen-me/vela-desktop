import { DomainError } from './errors.ts';
import type { Order, OrderStatus } from './types.ts';

const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
    pending_new: ['new', 'rejected'],
    new: ['partially_filled', 'filled', 'canceled', 'expired'],
    partially_filled: ['filled', 'canceled', 'expired'],
    filled: [],
    canceled: [],
    rejected: [],
    expired: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
    return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
    if (!canTransition(from, to)) {
        throw new DomainError('ORDER_NOT_ACTIVE', `Illegal order transition ${from} -> ${to}`, {
            details: { from, to },
        });
    }
}

export function isWorking(order: Order): boolean {
    return order.status === 'pending_new' || order.status === 'new' || order.status === 'partially_filled';
}

export function canCancel(order: Order): boolean {
    return isWorking(order);
}

export function canAmend(order: Order): boolean {
    return order.status === 'new' || order.status === 'partially_filled';
}
