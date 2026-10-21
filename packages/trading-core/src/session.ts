import { DomainError } from './errors.ts';
import type { Bar, LocalTime, SessionOptions, Timeframe, TradingDayPlan } from './types.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const TIMEFRAME_MS: Record<Timeframe, number> = {
    '1m': MINUTE,
    '5m': 5 * MINUTE,
    '15m': 15 * MINUTE,
    '30m': 30 * MINUTE,
    '1h': HOUR,
    '2h': 2 * HOUR,
    '4h': 4 * HOUR,
};

const US_RTH_OPEN: LocalTime = { hour: 9, minute: 30 };
const US_RTH_CLOSE: LocalTime = { hour: 16, minute: 0 };
const DEFAULT_TZ = 'America/New_York';
const DEFAULT_FLATTEN_OFFSET = 5 * MINUTE;

interface DateParts {
    year: number;
    month: number;
    day: number;
}

interface ZonedParts extends DateParts {
    hour: number;
    minute: number;
    second: number;
}

function parseDate(date: string): DateParts {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!match) {
        throw new DomainError('VALIDATION_ERROR', `Invalid date "${date}", expected YYYY-MM-DD`);
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const probe = new Date(Date.UTC(year, month - 1, day));
    if (
        probe.getUTCFullYear() !== year ||
        probe.getUTCMonth() !== month - 1 ||
        probe.getUTCDate() !== day
    ) {
        throw new DomainError('VALIDATION_ERROR', `Invalid calendar date "${date}"`);
    }
    return { year, month, day };
}

function partsInZone(ms: number, timezone: string): ZonedParts {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(new Date(ms));
    const get = (type: Intl.DateTimeFormatPartTypes): number => {
        const value = parts.find((part) => part.type === type)?.value;
        if (value == null) throw new Error(`Missing ${type} in timezone ${timezone}`);
        return Number(value);
    };
    return {
        year: get('year'),
        month: get('month'),
        day: get('day'),
        hour: get('hour'),
        minute: get('minute'),
        second: get('second'),
    };
}

function zoneOffsetMs(ms: number, timezone: string): number {
    const p = partsInZone(ms, timezone);
    const localAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return localAsUtc - Math.floor(ms / 1000) * 1000;
}

function zonedToUtc(date: DateParts, time: LocalTime, timezone: string): number {
    const guess = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute);
    const firstOffset = zoneOffsetMs(guess, timezone);
    let result = guess - firstOffset;
    const secondOffset = zoneOffsetMs(result, timezone);
    if (secondOffset !== firstOffset) result = guess - secondOffset;
    return result;
}

function minutesOfDay(time: LocalTime): number {
    return time.hour * 60 + time.minute;
}

function isWeekend(date: DateParts): boolean {
    const day = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
    return day === 0 || day === 6;
}

export function timeframeMs(timeframe: Timeframe): number {
    const value = TIMEFRAME_MS[timeframe];
    if (!value) throw new DomainError('VALIDATION_ERROR', `Unsupported timeframe "${timeframe}"`);
    return value;
}

export function buildTradingDayPlan(options: SessionOptions): TradingDayPlan {
    const market = options.market ?? 'US';
    if (market !== 'US') {
        throw new DomainError('VALIDATION_ERROR', `Unsupported market "${market}"`);
    }
    const date = parseDate(options.date);
    const timezone = options.timezone ?? DEFAULT_TZ;
    const openTime = options.open ?? US_RTH_OPEN;
    const closeTime = options.close ?? US_RTH_CLOSE;
    const tf = timeframeMs(options.timeframe);
    const flattenOffset = options.flattenOffsetMs ?? DEFAULT_FLATTEN_OFFSET;

    const open = zonedToUtc(date, openTime, timezone);
    const close = zonedToUtc(date, closeTime, timezone);
    const flattenAt = close - flattenOffset;

    if (close <= open) {
        throw new DomainError('VALIDATION_ERROR', 'Session close must be after session open');
    }
    if (flattenOffset <= 0 || flattenAt <= open) {
        throw new DomainError('VALIDATION_ERROR', 'Flatten time must fall inside the session');
    }

    const holiday = options.holidays?.has(options.date) ?? false;
    const isTradingDay = !isWeekend(date) && !holiday;
    const decisionTimes: number[] = [];
    if (isTradingDay) {
        for (let at = open + tf; at < flattenAt; at += tf) {
            decisionTimes.push(at);
        }
    }

    return {
        market,
        date: options.date,
        timezone,
        isTradingDay,
        open,
        close,
        flattenAt,
        isEarlyClose: minutesOfDay(closeTime) < minutesOfDay(US_RTH_CLOSE),
        timeframe: options.timeframe,
        decisionTimes,
    };
}

export function isDecisionTime(plan: TradingDayPlan, closeTime: number): boolean {
    return plan.decisionTimes.includes(closeTime);
}

export function isWithinSession(plan: TradingDayPlan, closeTime: number): boolean {
    return closeTime > plan.open && closeTime <= plan.close;
}

export function isBeforeFlatten(plan: TradingDayPlan, closeTime: number): boolean {
    return closeTime < plan.flattenAt;
}

export function sessionDateInZone(ms: number, timezone: string): string {
    const p = partsInZone(ms, timezone);
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function localTimeAt(ms: number, timezone: string): LocalTime {
    const p = partsInZone(ms, timezone);
    return { hour: p.hour, minute: p.minute };
}

export function inferSessionCloseFromBars(
    bars: readonly Bar[],
    plan: TradingDayPlan,
): LocalTime | null {
    const end = plan.close;
    const session = bars
        .filter((bar) => bar.openTime >= plan.open && bar.closeTime <= end)
        .sort((a, b) => a.closeTime - b.closeTime);
    const last = session[session.length - 1];
    if (!last) return null;
    if (last.closeTime >= end - 1000) return null;
    if (last.closeTime <= plan.open + timeframeMs(plan.timeframe)) return null;
    return localTimeAt(last.closeTime, plan.timezone);
}

export function formatPlanTimes(plan: TradingDayPlan): {
    open: string;
    close: string;
    flattenAt: string;
    firstDecision: string | null;
    lastDecision: string | null;
} {
    const format = (ms: number): string =>
        new Intl.DateTimeFormat('en-GB', {
            timeZone: plan.timezone,
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        }).format(new Date(ms));
    return {
        open: format(plan.open),
        close: format(plan.close),
        flattenAt: format(plan.flattenAt),
        firstDecision: plan.decisionTimes[0] == null ? null : format(plan.decisionTimes[0]),
        lastDecision:
            plan.decisionTimes.length === 0
                ? null
                : format(plan.decisionTimes[plan.decisionTimes.length - 1] as number),
    };
}
