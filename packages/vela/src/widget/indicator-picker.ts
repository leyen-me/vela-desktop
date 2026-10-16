// Indicator library — a three-pane browser over the widget's indicator manifest:
//   rail   — the sources/categories with live counts (on-chart, all, each family)
//   grid   — cards for the active category (or search results)
//   detail — the selected indicator + add/remove
// Add/remove is live against the current chart; the widget keeps the state.
import { Dialog } from '../ui/components/dialog';
import { injectStyles } from '../ui/styles';
import { iconEl } from '../ui/icons';
import { t } from '../i18n';

export interface IndicatorRow {
    name: string;
    language?: string;
    category?: string;
    /** Core-computed (native) indicator — accent styling + 'native' routing. */
    native?: boolean;
    /** Native type id (routing key for add/remove). */
    nativeType?: string;
    /** Beta badge (native catalog flag). */
    beta?: boolean;
    /** Host-owned, user-editable script (a custom indicator) — offers edit/delete. */
    editable?: boolean;
    /** Host id for an editable script (round-trips on the picker's DOM events). */
    id?: string;
}

const STYLE_ID = 'vela-widget-indpicker';const CSS = `
.vela-ip-dialog { width: min(1000px, 96vw); max-width: min(1000px, 96vw); }
.vela-ip-root { display: flex; flex-direction: column; height: 64vh; min-height: 420px; padding: 12px; gap: 12px; }
.vela-ip-searchrow {
    display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 12px;
    background: var(--vela-surface-elev); border: 1px solid var(--vela-border); border-radius: 8px;
}
.vela-ip-searchrow:focus-within { border-color: var(--vela-border-strong); }
.vela-ip-searchrow .vela-icon { color: var(--vela-fg-muted); }
.vela-ip-search { flex: 1; background: transparent; color: var(--vela-fg); border: none; font-size: 14px; outline: none; }
.vela-ip-panes { display: flex; flex: 1; min-height: 0; gap: 12px; }
.vela-ip-rail { flex: 0 0 190px; overflow-y: auto; padding-right: 4px; }
.vela-ip-rail-sec {
    color: var(--vela-fg-faint); font-size: 10px; font-weight: 700; text-transform: uppercase;
    letter-spacing: .08em; padding: 12px 8px 4px;
}
.vela-ip-rail-item {
    display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 6px;
    cursor: pointer; color: var(--vela-fg); font-size: 13px; user-select: none;
}
.vela-ip-rail-item:hover { background: var(--vela-hover); }
.vela-ip-rail-item[data-active='1'] { background: var(--vela-hover-strong); color: var(--vela-fg-bright); }
.vela-ip-rail-item .vela-ip-rail-label { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vela-ip-rail-item .vela-ip-rail-count { color: var(--vela-fg-faint); font-size: 12px; font-variant-numeric: tabular-nums; }
.vela-ip-rail-new { color: var(--vela-accent); font-weight: 600; }
.vela-ip-btn-ghost { background: transparent; color: var(--vela-fg); border-color: var(--vela-border); font-weight: 500; }
.vela-ip-btn-ghost:hover { background: var(--vela-hover); }
.vela-ip-grid { flex: 1; min-width: 0; overflow-y: auto; align-content: start;
    display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 10px; padding-right: 4px; }
.vela-ip-grid-sec { grid-column: 1 / -1; color: var(--vela-fg-muted); font-size: 11px; font-weight: 700;
    text-transform: uppercase; letter-spacing: .08em; padding: 8px 2px 0; }
.vela-ip-card {
    display: flex; flex-direction: column; gap: 8px; padding: 10px; cursor: pointer;
    background: var(--vela-surface-elev); border: 1px solid var(--vela-border); border-radius: 8px; min-height: 84px;
}
.vela-ip-card:hover { border-color: var(--vela-border-strong); background: var(--vela-hover); }
.vela-ip-card[data-active='1'] { border-color: var(--vela-accent); background: var(--vela-hover-strong); }
.vela-ip-card-top { display: flex; align-items: center; gap: 8px; }
.vela-ip-avatar {
    flex: none; width: 26px; height: 26px; border-radius: 6px; display: flex; align-items: center; justify-content: center;
    font-size: 11px; font-weight: 700; color: #fff; text-transform: uppercase;
}
.vela-ip-card-name { font-weight: 600; color: var(--vela-fg-bright); font-size: 13px; line-height: 1.25;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.vela-ip-card-meta { font-size: 11px; color: var(--vela-fg-muted); margin-top: auto; }
.vela-ip-detail { flex: 0 0 240px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto;
    border-left: 1px solid var(--vela-border); padding-left: 16px; }
.vela-ip-detail-name { font-size: 18px; font-weight: 700; color: var(--vela-fg-bright); line-height: 1.25; }
.vela-ip-detail-meta { font-size: 12px; color: var(--vela-fg-muted); }
.vela-ip-detail-actions { margin-top: auto; display: flex; flex-direction: column; gap: 8px; }
.vela-ip-btn {
    display: flex; align-items: center; justify-content: center; gap: 8px; height: 38px; border-radius: 8px;
    cursor: pointer; font-size: 14px; font-weight: 600; border: 1px solid var(--vela-border-strong);
    background: var(--vela-surface-elev); color: var(--vela-fg-bright);
}
.vela-ip-btn:hover { background: var(--vela-hover-strong); }
.vela-ip-btn-add { background: var(--vela-fg-bright); color: var(--vela-bg); border-color: var(--vela-fg-bright); }
.vela-ip-btn-add:hover { background: var(--vela-fg); }
.vela-ip-btn-remove { color: var(--vela-down); }
.vela-ip-hint { color: var(--vela-fg-faint); font-size: 13px; margin: auto 0; text-align: center; }
.vela-ip-badge {
    flex: none; padding: 1px 6px; border-radius: 4px; background: var(--vela-surface);
    border: 1px solid var(--vela-border); color: var(--vela-accent); font-size: 9px; font-weight: 700;
    letter-spacing: .06em; text-transform: uppercase;
}
.vela-ip-empty { grid-column: 1 / -1; padding: 24px; color: var(--vela-fg-muted); text-align: center; }
[data-layout='mobile'] .vela-ip-root { height: auto; min-height: 0; }
[data-layout='mobile'] .vela-ip-panes { flex-direction: column; }
[data-layout='mobile'] .vela-ip-rail, [data-layout='mobile'] .vela-ip-detail { display: none; }
[data-layout='mobile'] .vela-ip-grid { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
`;

export interface IndicatorPickerOptions {
    /** The manifest library — picking a card ADDS an instance (repeatable). */
    library: () => readonly IndicatorRow[];
    /** The live instances on the chart — the detail pane removes one. */
    onChart: () => readonly IndicatorRow[];
    onAdd: (libraryIndex: number) => void;
    onRemove: (instanceIndex: number) => void;
    onOpenChange?: (open: boolean) => void;
    host?: HTMLElement;
}

interface Pick {
    row: IndicatorRow;
    library?: number;
    instance?: number;
}

function hueOf(name: string): number {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
    return h;
}

export class IndicatorPicker {
    private readonly dialog: Dialog;
    private readonly search: HTMLInputElement;
    private readonly rail: HTMLElement;
    private readonly grid: HTMLElement;
    private readonly detail: HTMLElement;
    private readonly opts: IndicatorPickerOptions;
    private isOpen = false;
    private activeKey = 'all';
    private selected: Pick | null = null;

    constructor(opts: IndicatorPickerOptions) {
        this.opts = opts;
        const doc = (opts.host ?? document.body).ownerDocument;
        injectStyles(STYLE_ID, CSS, doc);

        this.search = doc.createElement('input');
        this.search.className = 'vela-ip-search';
        this.search.placeholder = t('Search indicators…');
        this.search.spellcheck = false;
        this.search.addEventListener('input', () => this.refresh());
        const searchRow = doc.createElement('div');
        searchRow.className = 'vela-ip-searchrow';
        searchRow.append(iconEl('search', doc), this.search);

        this.rail = doc.createElement('aside');
        this.rail.className = 'vela-ip-rail';
        this.grid = doc.createElement('section');
        this.grid.className = 'vela-ip-grid';
        this.detail = doc.createElement('aside');
        this.detail.className = 'vela-ip-detail';
        const panes = doc.createElement('div');
        panes.className = 'vela-ip-panes';
        panes.append(this.rail, this.grid, this.detail);
        const root = doc.createElement('div');
        root.className = 'vela-ip-root';
        root.append(searchRow, panes);

        this.rail.addEventListener('click', (e) => {
            const item = (e.target as HTMLElement).closest<HTMLElement>('.vela-ip-rail-item');
            if (!item) return;
            if (item.dataset.key === '__new') { this.emit('vela-indicator-new'); return; }
            this.activeKey = item.dataset.key ?? 'all';
            this.selected = null;
            this.refresh();
        });
        this.grid.addEventListener('click', (e) => {
            const card = (e.target as HTMLElement).closest<HTMLElement>('.vela-ip-card');
            if (!card) return;
            const pick = this.pickFromCard(card);
            if (!pick) return;
            this.selected = pick;
            this.render();
        });
        this.grid.addEventListener('dblclick', (e) => {
            const card = (e.target as HTMLElement).closest<HTMLElement>('.vela-ip-card');
            if (!card) return;
            const pick = this.pickFromCard(card);
            if (pick && pick.library !== undefined) { this.opts.onAdd(pick.library); this.refresh(); }
        });

        this.dialog = new Dialog({
            title: t('Indicators'),
            host: opts.host,
            className: 'vela-ip-dialog',
            draggable: true,
            flush: true,
            closeOnInteractOutside: true,
            content: (body) => body.append(root),
            onOpenChange: (open) => {
                this.isOpen = open;
                if (open) {
                    this.search.value = '';
                    this.activeKey = 'all';
                    this.selected = null;
                    this.refresh();
                    // Desktop only: focusing the search on a touch device would pop the
                    // on-screen keyboard over the just-opened fullscreen picker.
                    if (!this.search.closest('[data-layout="mobile"]')) setTimeout(() => this.search.focus(), 0);
                }
                opts.onOpenChange?.(open);
            },
        });
    }

    open(): void {
        this.dialog.show();
    }

    /** Re-render if open (async catalog updates land late). */
    sync(): void {
        if (this.isOpen) this.refresh();
    }

    close(): void {
        this.dialog.hide();
    }

    destroy(): void {
        this.dialog.destroy();
    }

    private pickFromCard(card: HTMLElement): Pick | null {
        const library = this.opts.library();
        const instances = this.opts.onChart();
        if (card.dataset.instance !== undefined) {
            const i = Number(card.dataset.instance);
            return instances[i] ? { row: instances[i]!, instance: i } : null;
        }
        const i = Number(card.dataset.library);
        return library[i] ? { row: library[i]!, library: i } : null;
    }

    private refresh(): void {
        this.render();
    }

    private render(): void {
        this.renderRail();
        this.renderGrid();
        this.renderDetail();
    }

    private renderRail(): void {
        const doc = this.rail.ownerDocument;
        const library = this.opts.library();
        const instances = this.opts.onChart();
        const counts = new Map<string, number>();
        for (const r of library) {
            const c = r.category ?? t('General');
            counts.set(c, (counts.get(c) ?? 0) + 1);
        }
        this.rail.replaceChildren();
        const newItem = doc.createElement('div');
        newItem.className = 'vela-ip-rail-item vela-ip-rail-new';
        newItem.dataset.key = '__new';
        newItem.append(iconEl('plus', doc));
        const newLabel = doc.createElement('span');
        newLabel.className = 'vela-ip-rail-label';
        newLabel.textContent = t('New script');
        newItem.appendChild(newLabel);
        this.rail.appendChild(newItem);
        const item = (key: string, label: string, count: number): HTMLElement => {
            const el = doc.createElement('div');
            el.className = 'vela-ip-rail-item';
            el.dataset.key = key;
            if (key === this.activeKey) el.dataset.active = '1';
            const l = doc.createElement('span');
            l.className = 'vela-ip-rail-label';
            l.textContent = label;
            const c = doc.createElement('span');
            c.className = 'vela-ip-rail-count';
            c.textContent = String(count);
            el.append(l, c);
            return el;
        };
        const sec = (label: string): HTMLElement => {
            const el = doc.createElement('div');
            el.className = 'vela-ip-rail-sec';
            el.textContent = label;
            return el;
        };
        this.rail.append(
            sec(t('Chart')),
            item('onchart', t('On chart'), instances.length),
            sec(t('Library')),
            item('all', t('All'), library.length),
        );
        if (counts.size) {
            this.rail.appendChild(sec(t('Families')));
            for (const [cat, n] of counts) this.rail.appendChild(item(`cat:${cat}`, cat, n));
        }
    }

    private renderGrid(): void {
        const doc = this.grid.ownerDocument;
        const q = this.search.value.trim().toLowerCase();
        const library = this.opts.library();
        const instances = this.opts.onChart();
        this.grid.replaceChildren();

        const match = (r: IndicatorRow): boolean => !q || r.name.toLowerCase().includes(q) || (r.category ?? '').toLowerCase().includes(q);

        const card = (p: Pick, key: string): HTMLElement => {
            const el = doc.createElement('div');
            el.className = 'vela-ip-card';
            if (p.library !== undefined) el.dataset.library = String(p.library);
            if (p.instance !== undefined) el.dataset.instance = String(p.instance);
            if (this.selected && this.selected.row.name === p.row.name && this.selected.library === p.library && this.selected.instance === p.instance) {
                el.dataset.active = '1';
            }
            const top = doc.createElement('div');
            top.className = 'vela-ip-card-top';
            const av = doc.createElement('span');
            av.className = 'vela-ip-avatar';
            av.style.background = `hsl(${hueOf(p.row.name)}, 42%, 40%)`;
            av.textContent = p.row.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2) || '?';
            const name = doc.createElement('span');
            name.className = 'vela-ip-card-name';
            name.textContent = p.row.name;
            top.append(av, name);
            if (p.row.beta) {
                const b = doc.createElement('span');
                b.className = 'vela-ip-badge';
                b.textContent = 'beta';
                top.appendChild(b);
            }
            const meta = doc.createElement('div');
            meta.className = 'vela-ip-card-meta';
            meta.textContent = p.row.category ?? (p.row.native ? 'VELA' : (p.row.language ?? ''));
            el.append(top, meta);
            void key;
            return el;
        };

        // Search spans everything (flat).
        if (q) {
            const hits = library.map((r, i) => [r, i] as const).filter(([r]) => match(r));
            if (!hits.length) {
                const empty = doc.createElement('div');
                empty.className = 'vela-ip-empty';
                empty.textContent = t('No indicators match.');
                this.grid.appendChild(empty);
                return;
            }
            for (const [r, i] of hits) this.grid.appendChild(card({ row: r, library: i }, String(i)));
            return;
        }

        if (this.activeKey === 'onchart') {
            if (!instances.length) {
                const empty = doc.createElement('div');
                empty.className = 'vela-ip-empty';
                empty.textContent = t('Nothing on the chart yet.');
                this.grid.appendChild(empty);
                return;
            }
            instances.forEach((r, i) => this.grid.appendChild(card({ row: r, instance: i }, `i${i}`)));
            return;
        }

        const wanted = this.activeKey.startsWith('cat:') ? this.activeKey.slice(4) : null;
        if (wanted) {
            const bucket = library.map((r, i) => [r, i] as const).filter(([r]) => (r.category ?? t('General')) === wanted);
            for (const [r, i] of bucket) this.grid.appendChild(card({ row: r, library: i }, `l${i}`));
            return;
        }

        // 'all' — cards grouped by category with headers.
        const byCat = new Map<string, Array<readonly [IndicatorRow, number]>>();
        library.forEach((r, i) => {
            const c = r.category ?? t('General');
            const b = byCat.get(c) ?? [];
            b.push([r, i] as const);
            byCat.set(c, b);
        });
        for (const [cat, bucket] of byCat) {
            const h = doc.createElement('div');
            h.className = 'vela-ip-grid-sec';
            h.textContent = cat;
            this.grid.appendChild(h);
            for (const [r, i] of bucket) this.grid.appendChild(card({ row: r, library: i }, `l${i}`));
        }
    }

    private renderDetail(): void {
        const doc = this.detail.ownerDocument;
        this.detail.replaceChildren();
        if (!this.selected) {
            const hint = doc.createElement('div');
            hint.className = 'vela-ip-hint';
            hint.textContent = t('Select an indicator');
            this.detail.appendChild(hint);
            return;
        }
        const { row, library, instance } = this.selected;
        const name = doc.createElement('div');
        name.className = 'vela-ip-detail-name';
        name.textContent = row.name;
        const meta = doc.createElement('div');
        meta.className = 'vela-ip-detail-meta';
        meta.textContent = [row.category, row.native ? 'VELA' : row.language].filter(Boolean).join(' · ');
        const actions = doc.createElement('div');
        actions.className = 'vela-ip-detail-actions';
        if (instance !== undefined) {
            const btn = doc.createElement('button');
            btn.className = 'vela-ip-btn vela-ip-btn-remove';
            btn.textContent = t('Remove from chart');
            btn.addEventListener('click', () => { this.opts.onRemove(instance); this.selected = null; this.refresh(); });
            actions.appendChild(btn);
        } else if (library !== undefined) {
            const btn = doc.createElement('button');
            btn.className = 'vela-ip-btn vela-ip-btn-add';
            btn.append(iconEl('plus', this.detail.ownerDocument), doc.createTextNode(t('Add to chart')));
            btn.addEventListener('click', () => { this.opts.onAdd(library); this.refresh(); });
            actions.appendChild(btn);
            if (row.editable) {
                const edit = doc.createElement('button');
                edit.className = 'vela-ip-btn vela-ip-btn-ghost';
                edit.textContent = t('Edit');
                edit.addEventListener('click', () => this.emit('vela-indicator-edit', { id: row.id, name: row.name }));
                const del = doc.createElement('button');
                del.className = 'vela-ip-btn vela-ip-btn-ghost';
                del.textContent = t('Delete');
                del.addEventListener('click', () => this.emit('vela-indicator-delete', { id: row.id, name: row.name }));
                actions.append(edit, del);
            }
        }
        this.detail.append(name, meta, actions);
    }

    /** Ask the host to open its editor / handle a custom script. Dispatched on the
     *  document so a host can listen once, without coupling the picker to its app. The
     *  picker closes first — the host's dialog takes over the screen. */
    private emit(type: string, detail?: unknown): void {
        this.close();
        if (typeof document === 'undefined') return;
        document.dispatchEvent(new CustomEvent(type, { detail }));
    }
}
