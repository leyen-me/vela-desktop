// WorkspaceReplay — every cell of a workspace replays on one clock: at any moment each
// chart shows exactly the bars that had CLOSED by the shared replay time.
import { describe, it, expect, afterEach } from 'vitest';
import { Vela } from '../src/index';
import { WorkspaceReplay, barClose, lastOpenClosedBy, type WorkspaceReplayHost } from '../src/workspace/WorkspaceReplay';
import type { IChartRenderer, RendererCapabilities, IndicatorRenderHandle, VisibleRange } from '../src/core/ports/IChartRenderer';
import type { MarketDataFeed, BarRange } from '../src/core/ports/MarketDataFeed';
import type { MarketConfig } from '../src/core/options';
import type { OHLCV } from '../src/core/model/ohlcv';
import type { IndicatorModel } from '../src/core/model/indicator';
import type { Unsubscribe } from '../src/core/util/types';

const MIN = 60_000;
const Q = 15 * MIN;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2024, 0, 1); // a Monday
const BASE_BARS = 4 * 24 * 40; // 40 days of 15m bars

const flush = async (): Promise<void> => {
    for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0));
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const tfMs = (tf: string | undefined): number => (tf === '15' ? Q : tf === 'D' ? DAY : HOUR);
const weekend = (t: number): boolean => [0, 6].includes(new Date(t).getUTCDay());

/** The symbol's bars on `tf`, aggregated from one 15m universe; `GAP` trades weekdays only. */
function series(symbol: string | undefined, tf: string | undefined): OHLCV[] {
    const step = tfMs(tf) / Q;
    const out: OHLCV[] = [];
    for (let i = 0; i < BASE_BARS; i += step) {
        const time = T0 + i * Q;
        if (symbol === 'GAP' && weekend(time)) continue;
        out.push({ time, open: i, high: i + step, low: i - 1, close: i + step - 1, volume: 1 });
    }
    return out;
}

class Feed implements MarketDataFeed {
    async load(cfg: MarketConfig): Promise<OHLCV[]> {
        return series(cfg.symbol, cfg.timeframe);
    }
    async loadRange(cfg: MarketConfig, r: BarRange): Promise<OHLCV[]> {
        return series(cfg.symbol, cfg.timeframe).filter((b) => (r.from == null || b.time >= r.from) && (r.to == null || b.time <= r.to));
    }
    subscribe(): Unsubscribe {
        return () => {};
    }
}

class Renderer implements IChartRenderer {
    readonly capabilities: RendererCapabilities = {
        panes: true, paneManagement: false, fills: 'primitive', bgcolor: 'primitive', hline: 'native',
        markers: true, barcolor: 'approximated', perPointColor: true, drawings: true, userDrawings: false, tables: true, inputsUI: true,
    };
    readonly name = 'fake';
    readonly features: readonly string[] = [];
    bars: OHLCV[] = [];
    applyFeature(): void {}
    readFeature(): unknown { return undefined; }
    mount(): void {}
    setTheme(): void {}
    resize(): void {}
    destroy(): void {}
    setBars(bars: OHLCV[]): void { this.bars = [...bars]; }
    updateBar(bar: OHLCV): void {
        const last = this.bars[this.bars.length - 1];
        if (last && last.time === bar.time) this.bars[this.bars.length - 1] = bar;
        else this.bars.push(bar);
    }
    setNativeData(): void {}
    ensurePane(): void {}
    removePane(): void {}
    mountIndicator(m: IndicatorModel): IndicatorRenderHandle { return { id: m.id }; }
    updateIndicator(): void {}
    removeIndicator(): void {}
    setIndicatorInputs(): void {}
    setIndicatorVisible(): void {}
    onInputChange(): Unsubscribe { return () => {}; }
    onRemoveIndicator(): Unsubscribe { return () => {}; }
    onCrosshairMove(): Unsubscribe { return () => {}; }
    onClick(): Unsubscribe { return () => {}; }
    getVisibleRange(): VisibleRange | null { return null; }
    setVisibleRange(): void {}
    onViewportChange(): Unsubscribe { return () => {}; }
}

type TestCell = { id: string; chart: Vela; renderer: Renderer };
const charts: Vela[] = [];

function cell(id: string, symbol: string, timeframe: string): TestCell {
    const renderer = new Renderer();
    const chart = new Vela({} as HTMLElement, { symbol, timeframe, bars: BASE_BARS, live: true, volume: false }, { renderer, dataFeed: new Feed() });
    charts.push(chart);
    return { id, chart, renderer };
}

/** A workspace stand-in: the cells, the active one, and the lifecycle events. */
function workspace(initial: TestCell[]) {
    const listeners = new Set<(e: { kind: 'created' | 'destroyed' | 'active'; id: string }) => void>();
    const state: { cells: TestCell[]; active: string } = { cells: initial, active: initial[0]!.id };
    const host: WorkspaceReplayHost = {
        cells: () => state.cells,
        activeId: () => state.active,
        onCells: (h) => {
            listeners.add(h);
            return () => listeners.delete(h);
        },
    };
    const ws = {
        get cells(): TestCell[] {
            return state.cells;
        },
        add(c: TestCell): void {
            state.cells = [...state.cells, c];
            for (const h of listeners) h({ kind: 'created', id: c.id });
        },
    };
    return { ws, replay: new WorkspaceReplay(host) };
}

/** The close of the newest bar a chart shows. */
const shownEnd = (c: TestCell): number => barClose(c.renderer.bars[c.renderer.bars.length - 1]!.time, c.chart.market.timeframe);

afterEach(() => {
    for (const c of charts.splice(0)) c.destroy();
});

describe('bar close arithmetic', () => {
    it('fixed timeframes add their length; month-based ones add calendar months', () => {
        expect(barClose(T0, '60')).toBe(T0 + HOUR);
        expect(barClose(T0, 'D')).toBe(T0 + DAY);
        expect(barClose(Date.UTC(2024, 0, 1), 'M')).toBe(Date.UTC(2024, 1, 1)); // 31 days
        expect(barClose(Date.UTC(2024, 1, 1), 'M')).toBe(Date.UTC(2024, 2, 1)); // 29 days (leap year)
        expect(barClose(Date.UTC(2024, 0, 1), '3M')).toBe(Date.UTC(2024, 3, 1));
        expect(lastOpenClosedBy(T0 + HOUR, '60')).toBe(T0);
        expect(lastOpenClosedBy(Date.UTC(2024, 2, 1), 'M')).toBe(Date.UTC(2024, 1, 1));
    });
});

describe('WorkspaceReplay', () => {
    it('start rewinds every chart to the shared time — no chart shows a bar that had not closed', async () => {
        const a = cell('a', 'AAA', '60');
        const b = cell('b', 'AAA', '15');
        const c = cell('c', 'AAA', 'D');
        const { replay } = workspace([a, b, c]);
        await Promise.all([a, b, c].map((x) => x.chart.ready()));
        const pick = T0 + 20 * DAY + 10 * HOUR; // the 10:00 bar of the 1h chart

        await replay.start({ from: pick });

        const clock = pick + HOUR; // that bar's close
        expect(shownEnd(a)).toBe(clock);
        expect(shownEnd(b)).toBe(clock); // the 15m chart up to its 10:45 bar
        expect(shownEnd(c)).toBeLessThanOrEqual(clock); // the daily chart up to yesterday
        expect(c.renderer.bars[c.renderer.bars.length - 1]!.time).toBe(T0 + 19 * DAY);
        expect(replay.state).toMatchObject({ active: true, playing: false, cursorTime: pick });
        for (const x of [a, b, c]) expect(x.chart.replay.state.active).toBe(true);
    });

    it('a step moves the clock to the next bar close on ANY chart: the finest sets the pace', async () => {
        const a = cell('a', 'AAA', '60');
        const b = cell('b', 'AAA', '15');
        const { replay } = workspace([a, b]);
        await Promise.all([a, b].map((x) => x.chart.ready()));
        const pick = T0 + 10 * DAY;
        await replay.start({ from: pick });
        const clock0 = pick + HOUR;
        const steps: number[] = [];
        replay.on('replay:step', (e) => steps.push(e.cursorTime));

        for (let i = 1; i <= 3; i += 1) {
            expect(replay.step()).toBe(true);
            expect(shownEnd(b)).toBe(clock0 + i * Q); // one 15m bar per step
            expect(shownEnd(a)).toBe(clock0); // the 1h bar is still forming
        }
        replay.step();
        expect(shownEnd(b)).toBe(clock0 + HOUR);
        expect(shownEnd(a)).toBe(clock0 + HOUR); // …and completes with the 4th
        expect(steps).toEqual([pick, pick, pick, pick + HOUR]); // reported for the active (1h) cell
    });

    it('a weekday-only market never shows Monday while the clock is still in the weekend', async () => {
        const a = cell('a', 'AAA', '60'); // trades around the clock
        const g = cell('g', 'GAP', '60'); // weekdays only
        const { replay } = workspace([a, g]);
        await Promise.all([a, g].map((x) => x.chart.ready()));
        const friday = T0 + 4 * DAY; // Jan 5
        await replay.start({ from: friday + 22 * HOUR });
        const lastBefore = g.renderer.bars[g.renderer.bars.length - 1]!.time;
        expect(lastBefore).toBe(friday + 22 * HOUR);

        for (let i = 0; i < 30; i += 1) replay.step(); // through Saturday into Sunday
        expect(shownEnd(a)).toBe(friday + 23 * HOUR + 30 * HOUR);
        expect(g.renderer.bars[g.renderer.bars.length - 1]!.time).toBe(friday + 23 * HOUR); // Friday's last bar, nothing more

        for (let i = 0; i < 25; i += 1) replay.step(); // into Monday
        expect(g.renderer.bars[g.renderer.bars.length - 1]!.time).toBeLessThan(shownEnd(a));
        expect(shownEnd(g)).toBe(shownEnd(a));
    });

    it('play advances on the shared clock; pause stops it', async () => {
        const a = cell('a', 'AAA', '60');
        const b = cell('b', 'AAA', '15');
        const { replay } = workspace([a, b]);
        await Promise.all([a, b].map((x) => x.chart.ready()));
        await replay.start({ from: T0 + 10 * DAY });
        const before = shownEnd(b);
        const events: string[] = [];
        replay.on('replay:play', () => events.push('play'));
        replay.on('replay:pause', () => events.push('pause'));

        replay.play(10);
        await sleep(120);
        replay.pause();
        const moved = shownEnd(b);
        expect(moved).toBeGreaterThanOrEqual(before + 4 * Q);
        expect(a.chart.replay.state.playing).toBe(false); // the charts' own timers never ran
        expect(b.chart.replay.state.playing).toBe(false);
        await sleep(40);
        expect(shownEnd(b)).toBe(moved);
        expect(events).toEqual(['play', 'pause']);
    });

    it('stop ends the replay on every chart, and so does any chart reaching its last bar', async () => {
        const a = cell('a', 'AAA', '60');
        const b = cell('b', 'AAA', '15');
        const { replay } = workspace([a, b]);
        await Promise.all([a, b].map((x) => x.chart.ready()));
        const ends: string[] = [];
        replay.on('replay:end', (e) => ends.push(e.reason));

        await replay.start({ from: T0 + 10 * DAY });
        replay.stop();
        expect([a, b].map((x) => x.chart.replay.state.active)).toEqual([false, false]);
        expect(replay.state.active).toBe(false);

        const hourly = series('AAA', '60');
        const lastHour = hourly[hourly.length - 1]!.time;
        await replay.start({ from: lastHour - 2 * HOUR }); // two 1h bars left
        for (let i = 0; i < 20 && replay.state.active; i += 1) replay.step();
        expect(replay.state.active).toBe(false);
        expect([a, b].map((x) => x.chart.replay.state.active)).toEqual([false, false]);
        expect(a.renderer.bars.length).toBe(hourly.length); // full history back
        expect(ends).toEqual(['stopped', 'finished']);
    });

    it('a cell added mid-replay joins at the shared time', async () => {
        const a = cell('a', 'AAA', '60');
        const { ws, replay } = workspace([a, cell('b', 'AAA', '15')]);
        await Promise.all(ws.cells.map((x) => x.chart.ready()));
        await replay.start({ from: T0 + 10 * DAY });
        replay.step();
        const clock = shownEnd(ws.cells[1] as TestCell);

        const late = cell('c', 'AAA', '15');
        ws.add(late);
        await late.chart.ready();
        await flush();

        expect(late.chart.replay.state.active).toBe(true);
        expect(shownEnd(late)).toBe(clock);
    });

    it('a cell switching symbol rejoins the replay once its new bars land', async () => {
        const a = cell('a', 'AAA', '60');
        const b = cell('b', 'AAA', '60');
        const { replay } = workspace([a, b]);
        await Promise.all([a, b].map((x) => x.chart.ready()));
        await replay.start({ from: T0 + 10 * DAY });
        replay.step();
        const clock = shownEnd(a);
        const ends: string[] = [];
        replay.on('replay:end', (e) => ends.push(e.reason));

        await b.chart.setMarket({ symbol: 'GAP' });
        await flush();

        expect(b.chart.market.symbol).toBe('GAP');
        expect(b.chart.replay.state.active).toBe(true);
        expect(shownEnd(b)).toBeLessThanOrEqual(clock);
        expect(replay.state.active).toBe(true);
        expect(ends).toEqual([]); // the workspace replay never ended
    });

    it('a single-chart layout hands every call to the chart itself (tick replay included)', async () => {
        const a = cell('a', 'AAA', '60');
        const { replay } = workspace([a]);
        await a.chart.ready();
        await replay.start({ from: T0 + 10 * DAY });
        a.chart.replay.setTicks((bar) => [{ price: bar.open + 1 }, { price: bar.open + 2 }, { price: bar.close }]);
        const ticks: number[] = [];
        replay.on('replay:tick', (e) => ticks.push(e.index));

        replay.stepUpdate();
        replay.stepUpdate();
        expect(ticks).toEqual([0, 1]); // tick by tick, through the chart's own replay

        replay.play(10);
        expect(a.chart.replay.state.playing).toBe(true); // the chart's own timer paces the ticks
        replay.pause();
        expect(a.chart.replay.state.playing).toBe(false);
    });
});
