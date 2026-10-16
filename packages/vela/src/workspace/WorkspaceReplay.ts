// Bar replay across a whole workspace: every cell replays on ONE clock. Each chart keeps
// its own `chart.replay` (per-chart history, indicators, watermark); this drives them all
// so that at any moment every chart shows exactly the bars that had CLOSED by the shared
// replay time — a 1h chart and a 1D chart next to each other never reveal the future to
// one another. A single-chart layout hands every call straight to that chart's replay
// (tick replay included).
import type { Vela } from '../Vela';
import { TypedEventBus } from '../core/events/EventBus';
import type { VelaEventMap } from '../core/events/types';
import type { ReplayBounds, ReplayEndReason, ReplayState } from '../core/ReplayControl';
import { timeframeToMs } from '../data/timeframe';

/** The workspace replay's events — the chart `replay:*` events, reported for the ACTIVE cell. */
export interface WorkspaceReplayEventMap extends Record<string, unknown> {
    'replay:start': VelaEventMap['replay:start'];
    'replay:step': VelaEventMap['replay:step'];
    'replay:tick': VelaEventMap['replay:tick'];
    'replay:play': VelaEventMap['replay:play'];
    'replay:pause': undefined;
    'replay:end': VelaEventMap['replay:end'];
}

/** Options for {@link WorkspaceReplay.start}. */
export interface WorkspaceReplayStartOptions {
    /** Epoch ms, read on `cell`'s chart as `chart.replay.start({ from })` reads it: that chart
     *  keeps every bar opened at or before it. The close of its last kept bar becomes the
     *  shared replay time, and every other chart keeps the bars closed by then. */
    from: number;
    /** The cell `from` is read on (default: the active cell). */
    cell?: string;
}

/** What the controller reads from its workspace. */
export interface WorkspaceReplayHost {
    cells(): ReadonlyArray<{ readonly id: string; readonly chart: Vela }>;
    activeId(): string | null;
    onCells(handler: (e: { kind: 'created' | 'destroyed' | 'active'; id: string }) => void): () => void;
}

type Cell = { readonly id: string; readonly chart: Vela };

/** How many bars one step may reveal on a single chart (a runaway-loop guard, never a real limit). */
const MAX_BARS_PER_STEP = 100_000;

/**
 * The workspace's bar-replay control surface (`workspace.replay`, `ctx.replay` for
 * contributions): the same verbs as `chart.replay`, applied to every cell on a shared
 * clock. A step moves the clock to the next bar close on ANY chart, and each chart reveals
 * the bars closed by then — so the finest timeframe sets the pace and a coarser chart
 * shows its bar when it completes. Cells added while replaying join at the shared time; a
 * cell switching symbol rejoins once its new bars load; a timeframe switch keeps the
 * cell's place. The replay ends on every chart together: `stop()`, or any chart reaching
 * its last bar. In a multi-chart layout bars are revealed whole (tick replay needs a
 * single-chart layout).
 */
export class WorkspaceReplay {
    private readonly bus = new TypedEventBus<WorkspaceReplayEventMap>();
    /** The running session: the shared replay time (every chart shows the bars closed by it). */
    private session: { clock: number } | null = null;
    private playing = false;
    private intervalMs = 1_000;
    private timer: ReturnType<typeof setTimeout> | null = null;
    /** Cells whose replay a symbol switch ended — restarted at the shared time once their bars land. */
    private readonly rejoining = new Set<string>();
    private readonly cellSubs = new Map<string, () => void>();
    private readonly offHost: () => void;
    /** Inside a group step: chart events are the controller's own doing. */
    private stepping = false;
    /** Inside `finish`: the charts' `replay:end` events are the controller's own doing. */
    private stopping = false;
    /** Driving a chart's own timer: its play/pause events are not the user's. */
    private muted = 0;
    /** A chart finished during a group step — the session ends right after it. */
    private finishedDuringStep = false;

    constructor(private readonly host: WorkspaceReplayHost) {
        for (const cell of host.cells()) this.watch(cell);
        this.offHost = host.onCells((e) => {
            if (e.kind === 'created') this.onCellCreated(e.id);
            else if (e.kind === 'destroyed') this.onCellDestroyed(e.id);
        });
    }

    /**
     * Enter replay on every cell (or seek, when already replaying) — paused. Resolves once
     * every chart shows its rewound history (a chart whose history does not reach that far
     * loads older bars first). A chart with nothing to replay after the shared time stays
     * as it is.
     */
    async start(opts: WorkspaceReplayStartOptions): Promise<void> {
        const cells = this.host.cells();
        const ref = cells.find((c) => c.id === (opts.cell ?? this.host.activeId())) ?? cells[0];
        if (!ref) return;
        if (this.playing) this.pause();
        this.rejoining.clear();
        await ref.chart.replay.start({ from: opts.from });
        const cursor = ref.chart.replay.state.cursorTime;
        if (cursor == null) return; // nothing to replay there — the chart warned
        const session = { clock: barClose(cursor, ref.chart.market.timeframe) };
        this.session = session;
        await Promise.all(this.host.cells().filter((c) => c.id !== ref.id).map((c) => this.startCell(c, session.clock)));
        if (this.session !== session) return; // stopped or superseded meanwhile
        this.syncPlayback();
        const s = this.activeChart()?.replay.state;
        this.bus.emit('replay:start', { cursorTime: s?.cursorTime ?? cursor, remaining: s?.remaining ?? 0 });
    }

    /** Reveal the next bar(s): the clock moves to the next bar close on any chart. Returns false when nothing is left. */
    step(): boolean {
        const solo = this.solo();
        return solo ? solo.replay.step() : this.stepGroup();
    }

    /** Reveal the next update — in a single-chart layout, the chart's `stepUpdate()` (tick replay); otherwise {@link step}. */
    stepUpdate(): boolean {
        const solo = this.solo();
        return solo ? solo.replay.stepUpdate() : this.stepGroup();
    }

    /** Advance one update every `intervalMs` (default: the last pace, initially 1000). Calling it again while playing changes the pace. */
    play(intervalMs?: number): this {
        if (!this.session) return this;
        if (intervalMs !== undefined) {
            if (!(Number.isFinite(intervalMs) && intervalMs > 0)) {
                console.warn(`[vela] workspace.replay.play(${intervalMs}) ignored — the interval must be a positive number of ms`);
                return this;
            }
            this.intervalMs = intervalMs;
        }
        this.playing = true;
        this.clearTimer();
        this.syncPlayback();
        this.bus.emit('replay:play', { intervalMs: this.intervalMs });
        return this;
    }

    pause(): this {
        if (!this.playing) return this;
        this.playing = false;
        this.syncPlayback();
        this.bus.emit('replay:pause', undefined);
        return this;
    }

    /** Leave replay on every chart: full history back, live updates resumed. */
    stop(): this {
        this.finish('stopped');
        return this;
    }

    /** `active`/`playing`/`intervalMs` for the whole workspace; the cursor fields read the ACTIVE cell's chart. */
    get state(): ReplayState {
        const s = this.session ? this.activeChart()?.replay.state : undefined;
        return {
            active: this.session !== null,
            playing: this.playing,
            cursorTime: s?.cursorTime ?? null,
            remaining: s?.remaining ?? 0,
            nextTime: s?.nextTime ?? null,
            intervalMs: this.intervalMs,
        };
    }

    /** The active cell's replayable history (`chart.replay.bounds`). */
    get bounds(): ReplayBounds | null {
        return this.activeChart()?.replay.bounds ?? null;
    }

    on<K extends keyof WorkspaceReplayEventMap>(event: K, handler: (payload: WorkspaceReplayEventMap[K]) => void): () => void {
        return this.bus.on(event, handler);
    }

    destroy(): void {
        this.session = null;
        this.playing = false;
        this.clearTimer();
        this.offHost();
        for (const off of this.cellSubs.values()) off();
        this.cellSubs.clear();
        this.bus.clear();
    }

    // ── internals ──

    /** The one chart of a single-chart layout — it replays on its own, tick replay included. */
    private solo(): Vela | null {
        const cells = this.host.cells();
        return cells.length === 1 ? cells[0]!.chart : null;
    }

    private activeChart(): Vela | null {
        const cells = this.host.cells();
        return (cells.find((c) => c.id === this.host.activeId()) ?? cells[0])?.chart ?? null;
    }

    /** Rewind one chart to the shared time: every bar that closed by `clock`, none after. */
    private async startCell(cell: Cell, clock: number): Promise<void> {
        const replay = cell.chart.replay;
        const from = lastOpenClosedBy(clock, cell.chart.market.timeframe);
        const bounds = replay.bounds;
        if (!bounds || bounds.last <= from) return; // no bar after the shared time (a market paused, or not loaded)
        await replay.start({ from });
    }

    /** Move the clock to the next bar close on any chart; each chart reveals what closed by then. */
    private stepGroup(): boolean {
        const session = this.session;
        if (!session) return false;
        const cells = this.host.cells();
        let next = Infinity;
        for (const c of cells) {
            const t = c.chart.replay.state.nextTime;
            if (t != null) next = Math.min(next, barClose(t, c.chart.market.timeframe));
        }
        if (!Number.isFinite(next)) return false;
        this.stepping = true;
        try {
            for (const c of cells) {
                const tf = c.chart.market.timeframe;
                for (let n = 0; n < MAX_BARS_PER_STEP; n += 1) {
                    const t = c.chart.replay.state.nextTime;
                    if (t == null || barClose(t, tf) > next) break;
                    if (!c.chart.replay.step()) break;
                }
            }
        } finally {
            this.stepping = false;
        }
        session.clock = next;
        if (this.finishedDuringStep) {
            this.finishedDuringStep = false;
            this.finish('finished');
            return true;
        }
        const s = this.activeChart()?.replay.state;
        if (s?.cursorTime != null) this.bus.emit('replay:step', { cursorTime: s.cursorTime, remaining: s.remaining });
        return true;
    }

    /** Put the timers in the state `playing` asks for: a single chart runs its own (it paces
     *  ticks), several run on the controller's clock. */
    private syncPlayback(): void {
        const solo = this.solo();
        const run = this.playing && this.session !== null;
        this.muted += 1;
        try {
            for (const c of this.host.cells()) {
                if (c.chart === solo && run) {
                    if (!c.chart.replay.state.playing || c.chart.replay.state.intervalMs !== this.intervalMs) c.chart.replay.play(this.intervalMs);
                } else if (c.chart.replay.state.playing) {
                    c.chart.replay.pause();
                }
            }
        } finally {
            this.muted -= 1;
        }
        if (!run || solo) this.clearTimer();
        else if (this.timer == null) this.schedule();
    }

    private schedule(): void {
        this.timer = setTimeout(() => {
            this.timer = null;
            if (!this.playing || !this.session || this.solo()) return;
            if (this.stepGroup() || this.rejoining.size > 0) {
                if (this.playing && this.session && this.timer == null) this.schedule();
            } else {
                this.pause(); // nothing left to step on any chart
            }
        }, this.intervalMs);
    }

    private clearTimer(): void {
        if (this.timer != null) clearTimeout(this.timer);
        this.timer = null;
    }

    /** End the session on every chart (idempotent). */
    private finish(reason: ReplayEndReason): void {
        const had = this.session !== null;
        this.session = null;
        this.playing = false;
        this.clearTimer();
        this.rejoining.clear();
        this.stopping = true;
        try {
            for (const c of this.host.cells()) c.chart.replay.stop(); // also cancels a start still loading history
        } finally {
            this.stopping = false;
        }
        if (had) this.bus.emit('replay:end', { reason });
    }

    private watch(cell: Cell): void {
        const { id, chart } = cell;
        const isActive = (): boolean => (this.host.activeId() ?? this.host.cells()[0]?.id) === id;
        const offs = [
            chart.on('replay:end', ({ reason }) => {
                if (!this.session || this.stopping) return;
                if (reason === 'market') this.rejoining.add(id);
                else if (this.stepping) this.finishedDuringStep ||= reason === 'finished';
                else this.finish(reason);
            }),
            chart.on('market:changed', () => {
                if (!this.rejoining.delete(id) || !this.session) return;
                void this.startCell(cell, this.session.clock).then(() => this.syncPlayback());
            }),
            chart.on('replay:step', (e) => {
                if (this.session && !this.stepping && isActive()) this.bus.emit('replay:step', e);
            }),
            chart.on('replay:tick', (e) => {
                if (this.session && isActive()) this.bus.emit('replay:tick', e);
            }),
            // A single chart runs its own timer: a pause it takes on its own (a seek) is the session's.
            chart.on('replay:pause', () => {
                if (!this.session || this.muted > 0 || !this.playing || chart !== this.solo()) return;
                this.playing = false;
                this.bus.emit('replay:pause', undefined);
            }),
        ];
        this.cellSubs.set(id, () => {
            for (const off of offs) off();
        });
    }

    private onCellCreated(id: string): void {
        const cell = this.host.cells().find((c) => c.id === id);
        if (!cell) return;
        this.watch(cell);
        const session = this.session;
        if (!session) return;
        // A cell born mid-replay joins at the shared time once its first bars are on screen.
        this.rejoining.add(id);
        void cell.chart.ready().then(async () => {
            if (this.session !== session || !this.rejoining.delete(id)) return;
            await this.startCell(cell, session.clock);
            this.syncPlayback();
        });
        this.syncPlayback();
    }

    private onCellDestroyed(id: string): void {
        this.cellSubs.get(id)?.();
        this.cellSubs.delete(id);
        this.rejoining.delete(id);
        this.syncPlayback();
    }
}

/** When a bar opened at `open` closes on `timeframe` — calendar months for month-based ones. */
export function barClose(open: number, timeframe: string | undefined): number {
    const months = monthSpan(timeframe);
    if (months > 0) {
        const d = new Date(open);
        return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes());
    }
    return open + timeframeToMs(timeframe ?? '60');
}

/** The latest open whose bar has closed by `time` on `timeframe` (the inverse of {@link barClose}). */
export function lastOpenClosedBy(time: number, timeframe: string | undefined): number {
    const months = monthSpan(timeframe);
    if (months > 0) {
        const d = new Date(time);
        return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - months, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes());
    }
    return time - timeframeToMs(timeframe ?? '60');
}

/** How many calendar months a month-based timeframe spans (`M`, `3M`, …); 0 otherwise. */
function monthSpan(timeframe: string | undefined): number {
    const m = /^(\d*)M$/.exec((timeframe ?? '').trim());
    return m ? Number(m[1] || 1) : 0;
}
