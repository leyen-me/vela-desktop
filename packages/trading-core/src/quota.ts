import { DomainError } from './errors.ts';
import type { EntryQuotaSnapshot } from './types.ts';

export class EntryQuota {
    readonly limit: number;
    private usedCount = 0;
    private reservedCount = 0;

    constructor(limit: number) {
        if (!Number.isInteger(limit) || limit < 0) {
            throw new DomainError('VALIDATION_ERROR', `Entry limit must be a non-negative integer, got ${limit}`);
        }
        this.limit = limit;
    }

    get used(): number {
        return this.usedCount;
    }

    get reserved(): number {
        return this.reservedCount;
    }

    get available(): number {
        return Math.max(0, this.limit - this.usedCount - this.reservedCount);
    }

    reserve(): void {
        if (this.available <= 0) {
            throw new DomainError(
                'DAILY_ENTRY_LIMIT_REACHED',
                `Daily entry limit reached (${this.usedCount}/${this.limit})`,
                {
                    suggestedAction: 'manage_existing',
                    details: {
                        limit: this.limit,
                        used: this.usedCount,
                        reserved: this.reservedCount,
                        available: this.available,
                    },
                },
            );
        }
        this.reservedCount += 1;
    }

    release(): void {
        if (this.reservedCount > 0) this.reservedCount -= 1;
    }

    consumeReservation(): void {
        if (this.reservedCount <= 0) {
            throw new DomainError('INTERNAL', 'Entry quota consume without a reservation');
        }
        this.reservedCount -= 1;
        this.usedCount += 1;
    }

    snapshot(): EntryQuotaSnapshot {
        return {
            limit: this.limit,
            used: this.usedCount,
            reserved: this.reservedCount,
            available: this.available,
        };
    }
}
