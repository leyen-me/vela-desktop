import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTradingDayPlan, formatPlanTimes } from '../src/session.ts';

test('US RTH 5m plan excludes open and flatten close from decisions', () => {
    const plan = buildTradingDayPlan({ date: '2026-10-20', timeframe: '5m' });
    const times = formatPlanTimes(plan);
    assert.equal(plan.isTradingDay, true);
    assert.equal(plan.isEarlyClose, false);
    assert.equal(times.open, '09:30');
    assert.equal(times.close, '16:00');
    assert.equal(times.flattenAt, '15:55');
    assert.equal(times.firstDecision, '09:35');
    assert.equal(times.lastDecision, '15:50');
    assert.equal(plan.decisionTimes.length, 76);
    assert.equal(plan.decisionTimes[0], plan.open + 5 * 60_000);
    assert.equal(plan.decisionTimes.at(-1), plan.open + 76 * 5 * 60_000);
    assert.ok(plan.decisionTimes.every((time) => time < plan.flattenAt));
});

test('US plan handles DST boundaries', () => {
    const edt = buildTradingDayPlan({ date: '2026-10-20', timeframe: '5m' });
    const est = buildTradingDayPlan({ date: '2026-11-02', timeframe: '5m' });
    assert.equal(edt.open, Date.UTC(2026, 9, 20, 13, 30));
    assert.equal(est.open, Date.UTC(2026, 10, 2, 14, 30));
});

test('half day moves flatten and last decision earlier', () => {
    const plan = buildTradingDayPlan({
        date: '2026-11-27',
        timeframe: '5m',
        close: { hour: 13, minute: 0 },
    });
    const times = formatPlanTimes(plan);
    assert.equal(plan.isEarlyClose, true);
    assert.equal(times.close, '13:00');
    assert.equal(times.flattenAt, '12:55');
    assert.equal(times.lastDecision, '12:50');
});

test('weekend and holiday are not trading days', () => {
    const weekend = buildTradingDayPlan({ date: '2026-10-24', timeframe: '5m' });
    const holiday = buildTradingDayPlan({
        date: '2026-10-20',
        timeframe: '5m',
        holidays: new Set(['2026-10-20']),
    });
    assert.equal(weekend.isTradingDay, false);
    assert.equal(weekend.decisionTimes.length, 0);
    assert.equal(holiday.isTradingDay, false);
});

test('invalid dates are rejected', () => {
    assert.throws(() => buildTradingDayPlan({ date: '2026-02-30', timeframe: '5m' }));
    assert.throws(() => buildTradingDayPlan({ date: '10/20/2026', timeframe: '5m' }));
});
