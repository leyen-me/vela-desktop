import test from 'node:test';
import assert from 'node:assert/strict';
import { EntryQuota } from '../src/quota.ts';
import { DomainError } from '../src/errors.ts';

test('entry quota reserves, consumes and releases', () => {
    const quota = new EntryQuota(2);
    quota.reserve();
    assert.deepEqual(quota.snapshot(), { limit: 2, used: 0, reserved: 1, available: 1 });
    quota.reserve();
    assert.equal(quota.available, 0);
    assert.throws(
        () => quota.reserve(),
        (error: unknown) =>
            error instanceof DomainError && error.code === 'DAILY_ENTRY_LIMIT_REACHED',
    );
    quota.release();
    assert.deepEqual(quota.snapshot(), { limit: 2, used: 0, reserved: 1, available: 1 });
    quota.consumeReservation();
    assert.deepEqual(quota.snapshot(), { limit: 2, used: 1, reserved: 0, available: 1 });
});

test('entry quota rejects invalid limits', () => {
    assert.throws(() => new EntryQuota(-1));
    assert.throws(() => new EntryQuota(1.5));
});
