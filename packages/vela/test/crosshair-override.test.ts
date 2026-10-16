// @vitest-environment jsdom
// The `crosshairOverride` renderer feature: a runtime-only restyle of the local crosshair
// (lines shown, color, style) that never reaches the saved config.
import { describe, it, expect } from 'vitest';
import { NativeRenderer } from '../src/renderers/native/NativeRenderer';
import { CrosshairRenderer } from '../src/renderers/native/chrome/CrosshairRenderer';
import { sanitizeCrosshairOverride } from '../src/renderers/native/core/chartConfig';
import { SceneGraph } from '../src/renderers/native/core/SceneGraph';
import { DARK_THEME } from '../src/core/theme';
import type { CoordinateSystem } from '../src/renderers/native/core/CoordinateSystem';

describe('sanitizeCrosshairOverride', () => {
    it('keeps well-formed fields, clamps numbers, drops the rest', () => {
        expect(sanitizeCrosshairOverride({ horizontal: false, color: '#2962ff', style: 'solid', width: 99, opacity: 3, junk: 1 })).toEqual({
            horizontal: false,
            color: '#2962ff',
            style: 'solid',
            width: 8,
            opacity: 1,
        });
        expect(sanitizeCrosshairOverride({ style: 'wavy', color: '' })).toBeNull();
        expect(sanitizeCrosshairOverride(null)).toBeNull();
        expect(sanitizeCrosshairOverride('solid')).toBeNull();
    });

    it('keeps a shadeRight with a color, clamping its opacity', () => {
        expect(sanitizeCrosshairOverride({ shadeRight: { color: '#000', opacity: 2 } })).toEqual({ shadeRight: { color: '#000', opacity: 1 } });
        expect(sanitizeCrosshairOverride({ shadeRight: { color: '#000' } })).toEqual({ shadeRight: { color: '#000' } });
        expect(sanitizeCrosshairOverride({ shadeRight: { opacity: 0.5 } })).toBeNull();
        expect(sanitizeCrosshairOverride({ shadeRight: '#000' })).toBeNull();
    });
});

describe('crosshairOverride feature', () => {
    it('is a declared feature that reads back sanitized and clears with null', () => {
        const r = new NativeRenderer();
        expect(r.features).toContain('crosshairOverride');
        expect(r.readFeature('crosshairOverride')).toBeNull();
        r.applyFeature('crosshairOverride', { horizontal: false, style: 'solid', bogus: true });
        expect(r.readFeature('crosshairOverride')).toEqual({ horizontal: false, style: 'solid' });
        r.applyFeature('crosshairOverride', null);
        expect(r.readFeature('crosshairOverride')).toBeNull();
    });

    it('never reaches the saved config', () => {
        const r = new NativeRenderer();
        const before = JSON.stringify(r.getConfig());
        r.applyFeature('crosshairOverride', { horizontal: false, color: '#ff0000', style: 'solid', width: 2, opacity: 1 });
        expect(JSON.stringify(r.getConfig())).toBe(before);
    });
});

describe('CrosshairRenderer under an override', () => {
    /** A 2d context that records the stroked segments, stroke styles and chip texts. */
    function recorder() {
        const segments: Array<{ from: [number, number]; to: [number, number] }> = [];
        const texts: string[] = [];
        const strokes: Array<{ style: string; dash: number[]; alpha: number }> = [];
        const fills: Array<{ style: string; alpha: number; rect: [number, number, number, number] }> = [];
        let at: [number, number] = [0, 0];
        let dash: number[] = [];
        const ctx = {
            font: '',
            textBaseline: '',
            textAlign: '',
            strokeStyle: '',
            fillStyle: '',
            lineWidth: 1,
            globalAlpha: 1,
            setTransform() {},
            clearRect() {},
            beginPath() {},
            moveTo(x: number, y: number) { at = [x, y]; },
            lineTo(x: number, y: number) { segments.push({ from: at, to: [x, y] }); },
            stroke() { strokes.push({ style: String(ctx.strokeStyle), dash, alpha: ctx.globalAlpha }); },
            setLineDash(d: number[]) { dash = d; },
            fillRect(x: number, y: number, w: number, h: number) { fills.push({ style: String(ctx.fillStyle), alpha: ctx.globalAlpha, rect: [x, y, w, h] }); },
            fillText(t: string) { texts.push(t); },
            measureText: (t: string) => ({ width: t.length * 6 }),
        };
        return { ctx, segments, texts, strokes, fills };
    }

    function paint(override: unknown, opts: { external?: { x: number; y: number | null; time: number; price?: number | null } } = {}) {
        const rec = recorder();
        const canvas = { width: 400, height: 300, getContext: () => rec.ctx } as unknown as HTMLCanvasElement;
        const cr = new CrosshairRenderer();
        cr.mount(canvas);
        const scene = new SceneGraph();
        scene.crosshair = opts.external ? null : { x: 100, y: 120 };
        scene.crosshairOverride = sanitizeCrosshairOverride(override);
        scene.panes.set('price', { id: 'price', kind: 'price', bounds: { top: 0, height: 280 }, scale: { min: 0, max: 100 }, axisFormat: 'price' } as never);
        const coords = {
            dpr: 1,
            width: 380,
            height: 280,
            barInterval: 3_600_000,
            xToLogical: (x: number) => x / 10,
            logicalToX: (l: number) => l * 10,
            logicalToTime: (l: number) => 1_700_000_000_000 + l * 3_600_000,
            yToPrice: () => 50,
        } as unknown as CoordinateSystem;
        cr.render(scene, coords, DARK_THEME, null, opts.external ?? null);
        return rec;
    }

    const isHorizontal = (s: { from: [number, number]; to: [number, number] }): boolean => s.from[1] === s.to[1];
    const isVertical = (s: { from: [number, number]; to: [number, number] }): boolean => s.from[0] === s.to[0];

    it('draws both lines and both chips by default', () => {
        const rec = paint(null);
        expect(rec.segments.some(isVertical)).toBe(true);
        expect(rec.segments.some(isHorizontal)).toBe(true);
        expect(rec.texts.length).toBe(2); // price chip + time chip
        expect(rec.strokes[0]!.dash).toEqual([6, 4]); // the configured dashed style
    });

    it('horizontal: false drops the level line and its price chip; the style fields apply', () => {
        const rec = paint({ horizontal: false, color: '#2962ff', style: 'solid', opacity: 1 });
        expect(rec.segments.some(isHorizontal)).toBe(false);
        expect(rec.segments.some(isVertical)).toBe(true);
        expect(rec.texts.length).toBe(1); // the time chip only
        expect(rec.strokes[0]).toEqual({ style: '#2962ff', dash: [], alpha: 1 });
    });

    it('the vertical line lands on the pixel grid for its width: half pixel when odd, pixel edge when even', () => {
        const xOf = (width?: number): number => paint({ horizontal: false, ...(width ? { width } : {}) }).segments.find(isVertical)!.from[0];
        expect(xOf()).toBe(100.5); // the configured 1px crosshair
        expect(xOf(2)).toBe(100);
        expect(xOf(3)).toBe(100.5);
    });

    it('shadeRight veils the plot from the bar right edge to the price scale, under the line', () => {
        const rec = paint({ horizontal: false, shadeRight: { color: '#101010', opacity: 0.6 } });
        // cursor x=100 → bar 10 at x=100; its right edge is logical 10.5 → x=105; plot is 380×280
        expect(rec.fills[0]).toEqual({ style: '#101010', alpha: 0.6, rect: [105, 0, 275, 280] });
        expect(rec.strokes[0]!.alpha).not.toBe(0.6); // the line keeps its own opacity
        expect(paint({ horizontal: false }).fills.some((f) => f.style === '#101010')).toBe(false);
    });

    it('a synced ghost crosshair wears the override too: its style, no level line, and the veil from its bar', () => {
        const ghost = { x: 200, y: 90, time: 1_700_000_000_000, price: 42 };
        const rec = paint({ horizontal: false, color: '#2962ff', style: 'solid', opacity: 1, shadeRight: { color: '#101010', opacity: 0.6 } }, { external: ghost });
        // ghost x=200 → bar 20; its right edge is logical 20.5 → x=205
        expect(rec.fills[0]).toEqual({ style: '#101010', alpha: 0.6, rect: [205, 0, 175, 280] });
        expect(rec.segments.some(isHorizontal)).toBe(false);
        expect(rec.strokes[0]).toEqual({ style: '#2962ff', dash: [], alpha: 0.55 }); // dimmed: still a ghost
        expect(rec.texts.length).toBe(1); // the time chip only
    });

    it('a ghost left of the window still veils every bar in view, with no line; without an override nothing shows', () => {
        const offLeft = { x: -50, y: null, time: 1_700_000_000_000, line: false };
        const rec = paint({ horizontal: false, shadeRight: { color: '#101010', opacity: 0.6 } }, { external: offLeft });
        expect(rec.fills[0]).toEqual({ style: '#101010', alpha: 0.6, rect: [0, 0, 380, 280] });
        expect(rec.strokes).toEqual([]);
        expect(rec.texts).toEqual([]);
        const plain = paint(null, { external: offLeft });
        expect(plain.fills.some((f) => f.style === '#101010')).toBe(false);
        expect(plain.strokes).toEqual([]);
    });

    it('without an override the ghost is unchanged: configured style, level line, no veil', () => {
        const rec = paint(null, { external: { x: 200, y: 90, time: 1_700_000_000_000, price: 42 } });
        expect(rec.fills.some((f) => f.style === '#101010')).toBe(false);
        expect(rec.segments.some(isHorizontal)).toBe(true);
        expect(rec.strokes[0]!.dash).toEqual([6, 4]);
    });
});
