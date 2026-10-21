import './error-boundary.ts';
import { VelaWorkspace, setLocale, registerRendererDefaults } from '@luxalgo/vela/workspace';
import { registerSidePanel } from '@luxalgo/vela/widget';
import { registerIcon, svg16 } from '@luxalgo/vela/ui';
import { PineWorkerEngine } from '@luxalgo/vela-pinets';
import { installIndicatorEditor } from './indicator-editor.ts';
import { registerBacktestPanel } from './backtest-panel.ts';
import { API_BASE, api } from './api.ts';

type Bar = { time: number; open: number; high: number; low: number; close: number; volume?: number };
type BarRange = { limit?: number; from?: number | null; to?: number | null };
type SymbolRow = { ticker: string; description?: string; type?: string; section?: string };
type JsonObject = Record<string, any>;
type VelaChart = any;
type VelaCell = any;

registerIcon('agent', svg16('<path d="M6.2 1.6c.6 2.4 1.6 3.4 4 4-2.4.6-3.4 1.6-4 4-.6-2.4-1.6-3.4-4-4 2.4-.6 3.4-1.6 4-4z" fill="currentColor" fill-opacity="0.2"/><path d="M12 9.2c.4 1.6 1.1 2.3 2.7 2.7-1.6.4-2.3 1.1-2.7 2.7-.4-1.6-1.1-2.3-2.7-2.7 1.6-.4 2.3-1.1 2.7-2.7z" fill="currentColor" fill-opacity="0.2"/>'));
registerBacktestPanel();

registerSidePanel({
  id: 'agent',
  title: 'AI 日内分析',
  icon: 'agent',
  order: 30,
  width: 380,
  resizable: true,
  minWidth: 300,
  maxWidth: 640,
  mount: mountAgentPanel,
});

// PineWorkerEngine builds its worker from a Blob URL and revokes that URL immediately
// after `new Worker(url)`. In Electron that races the ~850 KB script load: the worker
// never starts and script indicators stay stuck at "…". Defer the revocation.
const revokeObjectURL = URL.revokeObjectURL.bind(URL);
URL.revokeObjectURL = (url) => setTimeout(() => revokeObjectURL(url), 30_000);

const TF_MAP: Record<string, string> = {
  '1': '1m', '5': '5m', '15': '15m', '30': '30m',
  '60': '1h', '120': '2h', '240': '4h',
  D: '1d', W: '1w', M: '1M',
  '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1h', '2h': '2h', '4h': '4h',
  '1d': '1d', '1w': '1w', '1M': '1M',
};
const TF_MS: Record<string, number> = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000,
  '1d': 86_400_000, '1w': 604_800_000, '1M': 2_592_000_000,
};
// TradingView's datafeed asks for the bars that fill the visible area — typically
// around 300 — and fetches older history as the user scrolls. Mirror that: boot with
// a small window and extend it page by page on demand.
const INITIAL_BARS = 300;
const SLIDE_BARS = 1000;
const MAX_BARS = 20_000;

// Provider-side bookkeeping for the lazy history: the oldest bar delivered for each
// market, and whether the source ran out of older data.
const oldestByMarket = new Map<string, number>();
const newestByMarket = new Map<string, number>();
const exhaustedMarkets = new Set<string>();

class LongbridgeProvider {
  async getBars(ticker: string, timeframe: string, range?: BarRange): Promise<Bar[]> {
    const tf = TF_MAP[timeframe] || '1d';
    const params = new URLSearchParams({
      symbol: ticker,
      tf,
      count: String(range?.limit || 500),
    });
    if (range?.from != null) params.set('from', String(range.from));
    if (range?.to != null) params.set('to', String(range.to));
    let lastErr: unknown;
    for (let i = 0; i < 3; i++) {
      try {
        const data = await api.get(`/bars?${params}`);
        const bars = data?.bars as Bar[] | undefined;
        if (!Array.isArray(bars)) throw new Error('invalid bars response');
        const key = `${ticker}|${tf}`;
        const unbounded = range?.from == null && range?.to == null;
        if (bars.length > 0) {
          // A full request redefines the window (symbol/timeframe switch); an older
          // window only ever pushes the left edge further back.
          const previousOldest = oldestByMarket.get(key);
          if (unbounded || previousOldest == null || bars[0].time < previousOldest) {
            oldestByMarket.set(key, bars[0].time);
          }
          const newest = bars[bars.length - 1].time;
          const previousNewest = newestByMarket.get(key);
          if (unbounded || previousNewest == null || newest > previousNewest) {
            newestByMarket.set(key, newest);
          }
        }
        if (unbounded) exhaustedMarkets.delete(key);
        else if (range?.limit && bars.length < range.limit) exhaustedMarkets.add(key);
        return bars;
      } catch (e) {
        lastErr = e;
        await new Promise((res) => setTimeout(res, 700 * (i + 1)));
      }
    }
    throw lastErr;
  }

  subscribe(ticker: string, timeframe: string, onBar: (bar: Bar) => void): () => void {
    const tf = TF_MAP[timeframe] || '1d';
    const params = new URLSearchParams({ symbol: ticker, tf });
    const es = new EventSource(`${API_BASE}/stream?${params}`);
    es.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (!msg?.bar) return;
        const key = `${ticker}|${tf}`;
        const newest = newestByMarket.get(key);
        if (newest == null || msg.bar.time > newest) newestByMarket.set(key, msg.bar.time);
        if (msg.confirmed) {
          window.dispatchEvent(new CustomEvent('vela:bar-close', {
            detail: { symbol: ticker, timeframe: tf, bar: msg.bar },
          }));
        }
        onBar(msg.bar);
      } catch {
        /* malformed frame — keep the stream open */
      }
    };
    es.addEventListener('stream-error', (event) => {
      let message = 'unknown error';
      try { message = JSON.parse(event.data).message; } catch {}
      console.warn('[longbridge] candlestick stream failed:', message);
    });
    return () => es.close();
  }

  async listSymbols() {
    const rows: SymbolRow[] = [];
    for (let page = 1; ; page += 1) {
      const data = await api.get(`/symbols?page=${page}&pageSize=5000`);
      rows.push(...(data?.items ?? []));
      if (rows.length >= (data?.total ?? 0) || !data?.items?.length) break;
    }
    return rows.map((s) => ({
      ticker: s.ticker, description: s.description, type: s.type, section: s.section,
    }));
  }

  info() {
    return {
      name: 'longbridge',
      displayName: '长桥',
      supportedTimeframes: Object.keys(TF_MAP),
      capabilities: { enumerate: true, stream: true, symbolInfo: false },
    };
  }
}

const PERSIST_KEY = 'vela-client-longbridge';
const TIMEFRAME_FAVORITES = ['1', '5', '15', '60', '240', 'D', 'W', 'M'];
// Indicators every chart starts with. Volume is a native study; the other is the
// manifest name served by /api/v1/indicators.json.
const DEFAULT_STUDIES = { native: 'volume', manifest: 'Smart Money Concepts' };
// Bump the version to re-apply the defaults to workspaces saved before this change.
const DEFAULTS_FLAG = 'host.defaultIndicators';
const DEFAULTS_VERSION = 2;
// The catalogue title differs from the name the script declares; a ledger entry must
// carry the declared one.
const LEGACY_STUDY_NAMES = ['Smart Money Concepts (SMC)'];

function seedDefaultStudies(doc: JsonObject): JsonObject {
  const ext = doc.ext && typeof doc.ext === 'object' && !Array.isArray(doc.ext) ? doc.ext : {};
  if (ext[DEFAULTS_FLAG] === DEFAULTS_VERSION) return doc;
  if (Array.isArray(doc.charts)) {
    for (const chart of doc.charts) {
      if (!chart || typeof chart !== 'object') continue;
      const current = chart.indicators;
      const natives = Array.isArray(current?.natives) ? [...current.natives] : [];
      const manifest = Array.isArray(current?.manifest)
        ? current.manifest.filter((e: any) => !LEGACY_STUDY_NAMES.includes(typeof e === 'string' ? e : e?.name))
        : [];
      const typeOf = (e: any) => (typeof e === 'string' ? e : e?.type);
      const nameOf = (e: any) => (typeof e === 'string' ? e : e?.name);
      if (!natives.some((e: any) => typeOf(e) === DEFAULT_STUDIES.native)) natives.push(DEFAULT_STUDIES.native);
      if (!manifest.some((e: any) => nameOf(e) === DEFAULT_STUDIES.manifest)) manifest.push(DEFAULT_STUDIES.manifest);
      chart.indicators = { manifest, natives };
    }
  }
  doc.ext = { ...ext, [DEFAULTS_FLAG]: DEFAULTS_VERSION };
  return doc;
}

async function loadIndicators() {
  const list = await api.get('/indicators.json');
  if (!Array.isArray(list)) throw new Error('invalid indicators manifest');
  return list.map((e: JsonObject) => (e.name === DEFAULT_STUDIES.manifest ? { ...e, enabled: true } : e));
}
// Display timezone for the axis / bottom bar (IANA). The persisted workspace doc
// carries its own `timezone`, so we force it here too.
const TIMEZONE = 'America/New_York';

// Vela draws the favorite timeframes as one-click switch chips in the topbar
// (and stars in the dropdown). The set only comes from the PERSISTED state, so
// we seed/merge it here — otherwise the topbar hides every timeframe behind the
// dropdown menu.
const storage = {
  get(key: string): string | null {
    let raw = null;
    try { raw = localStorage.getItem(key); } catch { return null; }
    if (key !== PERSIST_KEY) return raw;
    if (!raw) {
      const fresh = seedDefaultStudies({
        version: 1, layout: '1', timezone: TIMEZONE, timeframeFavorites: TIMEFRAME_FAVORITES,
        ext: { 'host.agentPanelSeen': true },
      });
      fresh.panels = { open: 'agent' };
      return JSON.stringify(fresh);
    }
    try {
      const doc: JsonObject = JSON.parse(raw);
      doc.timezone = TIMEZONE;
      if (!Array.isArray(doc.timeframeFavorites) || doc.timeframeFavorites.length === 0) {
        doc.timeframeFavorites = TIMEFRAME_FAVORITES;
      }
      if (Array.isArray(doc.charts)) {
        for (const c of doc.charts) {
          // Every boot starts from the small window; scrolling grows it on demand.
          c.bars = INITIAL_BARS;
        }
      }
      const seeded = seedDefaultStudies(doc);
      const ext = seeded.ext && typeof seeded.ext === 'object' && !Array.isArray(seeded.ext) ? seeded.ext : {};
      if (ext['host.agentPanelSeen'] !== true) {
        // Show the agent column once for workspaces saved before it existed; closing it
        // later persists that choice (the marker stays, `open` does not).
        seeded.panels = { ...(seeded.panels || {}), open: 'agent' };
        seeded.ext = { ...ext, 'host.agentPanelSeen': true };
      }
      return JSON.stringify(seeded);
    } catch {
      return raw;
    }
  },
  set(key: string, value: string) { try { localStorage.setItem(key, value); } catch {} },
  remove(key: string) { try { localStorage.removeItem(key); } catch {} },
};

// Simplified-Chinese chrome. Set BEFORE the workspace is built so the very first
// render (including canvas-drawn axis ticks) comes out Chinese. See vela src/i18n.ts.
setLocale('zh-CN');

// Hide the in-chart Vela attribution mark (the bottom-left "V"). It is a licence
// obligation to show an equivalent visible "Vela™" notice when this is off — fine for
// a private build; re-add one if this is ever distributed.
registerRendererDefaults({ attribution: false });

const ws = new VelaWorkspace('#app', {
  layout: false,
  theme: 'dark',
  symbol: 'longbridge:SPY.US',
  timeframe: '5',
  bars: INITIAL_BARS,
  live: true,
  providers: { longbridge: () => new LongbridgeProvider() },
  engines: { pine: () => new PineWorkerEngine() },
  indicators: loadIndicators as any,
  topbar: { right: ['actions', 'panels'] },
  timezone: TIMEZONE,
  persist: PERSIST_KEY,
  storage,
});

// The persisted doc's own `timezone` wins on boot, so force the display zone here too.
ws.setTimezone(TIMEZONE);

// Lazy history: extending the depth prepends older bars and keeps the viewport put.
// A page loads when the left edge reaches the loaded history or when zooming out makes
// the visible window wider than everything loaded. Drag/zoom gestures also re-check on
// their own, because a drag at the pan limit emits no viewport change.
const slidingInstalled = new WeakSet();
const slideStyle = document.createElement('style');
slideStyle.textContent = `
.vslide-pill { position: absolute; left: 12px; top: 54px; z-index: 30; display: flex; align-items: center;
  gap: 8px; padding: 6px 10px; border-radius: 6px; background: rgba(30, 34, 45, .92);
  border: 1px solid rgba(255, 255, 255, .1); color: #d1d4dc; font: 12px/1.2 system-ui, sans-serif;
  pointer-events: none; }
.vslide-pill[hidden] { display: none !important; }
.vslide-spin { width: 12px; height: 12px; border: 2px solid rgba(255, 255, 255, .25);
  border-top-color: #fff; border-radius: 50%; animation: vslide-spin .8s linear infinite; }
@keyframes vslide-spin { to { transform: rotate(360deg); } }
`;
document.head.appendChild(slideStyle);

function installSliding(cell: VelaCell) {
  if (slidingInstalled.has(cell)) return;
  slidingInstalled.add(cell);
  const chart = cell.chart;
  let extending = false;
  let lastAt = 0;
  let guard: ReturnType<typeof setTimeout> | null = null;
  // Boot builds the initial frame through several viewport updates; only history the
  // user deliberately pans into may extend the window.
  let userActive = false;
  let dragging = false;
  let gestureTimer: ReturnType<typeof setTimeout> | null = null;

  const pill = document.createElement('div');
  pill.className = 'vslide-pill';
  pill.hidden = true;
  pill.innerHTML = '<span class="vslide-spin"></span><span class="vslide-text"></span>';
  cell.host.appendChild(pill);
  const setPill = (text: string | null) => {
    if (text == null) {
      pill.hidden = true;
      return;
    }
    pill.querySelector('.vslide-text')!.textContent = text;
    pill.hidden = false;
  };
  let shownAt = 0;
  let finishing = false;
  const finish = () => {
    if (finishing) return;
    finishing = true;
    if (guard) {
      clearTimeout(guard);
      guard = null;
    }
    // Keep a short minimum so an instant (cached) page still reads as an action.
    const wait = Math.max(0, 500 - (Date.now() - shownAt));
    setTimeout(() => {
      extending = false;
      finishing = false;
      setPill(null);
    }, wait);
  };

  chart.on('history:progress', ({ loaded, target }: { loaded: number; target: number }) => {
    if (extending && loaded < target) setPill(`加载更早数据 ${loaded}/${target}`);
  });
  chart.on('history:complete', () => {
    if (extending) finish();
  });

  const maybeExtend = () => {
    if (!userActive || extending) return;
    const range = chart.getVisibleRange();
    if (!range) return;
    const { from, to } = range;
    const market = chart.market;
    const tf = TF_MAP[market.timeframe] || '1d';
    const interval = TF_MS[tf] || 300_000;
    const key = `${(market.symbol ?? '').split(':').pop()}|${tf}`;
    const oldest = oldestByMarket.get(key);
    const newest = newestByMarket.get(key);
    const depth = market.bars ?? INITIAL_BARS;
    if (oldest == null || exhaustedMarkets.has(key)) return;
    if (depth >= MAX_BARS) return;
    // Two triggers: the left edge reached the oldest loaded bar, OR zooming out made
    // the visible window as wide as everything loaded (the view needs more history
    // even though the user never panned all the way to the left edge).
    const atEdge = from <= oldest + 100 * interval;
    const loadedSpan = newest != null ? newest - oldest : 0;
    const zoomedPast = loadedSpan > 0 && to - from >= loadedSpan * 0.95;
    if (!atEdge && !zoomedPast) return;
    if (Date.now() - lastAt < 800) return;
    extending = true;
    lastAt = Date.now();
    shownAt = Date.now();
    setPill('加载更早数据…');
    guard = setTimeout(finish, 30_000);
    chart
      .setMarket({ bars: Math.min(depth + SLIDE_BARS, MAX_BARS) })
      .catch(finish);
  };

  // A drag at the pan limit emits no viewport change, so the gesture itself has to
  // ask for the next page instead of waiting for the view to move.
  const scheduleExtend = () => {
    if (gestureTimer) clearTimeout(gestureTimer);
    gestureTimer = setTimeout(() => {
      gestureTimer = null;
      maybeExtend();
    }, 100);
  };
  cell.host.addEventListener('wheel', () => { userActive = true; scheduleExtend(); }, { capture: true, passive: true });
  cell.host.addEventListener('pointerdown', () => { userActive = true; dragging = true; }, { capture: true });
  cell.host.addEventListener('pointermove', () => { if (dragging) scheduleExtend(); }, { capture: true, passive: true });
  cell.host.addEventListener('pointerup', () => { dragging = false; scheduleExtend(); }, { capture: true });
  window.addEventListener('pointerup', () => { dragging = false; }, true);
  chart.on('viewport:changed', () => maybeExtend());
}
for (const cell of ws.cells()) installSliding(cell);
ws.on('cell:created', ({ id }) => {
  const cell = ws.cell(id);
  if (cell) installSliding(cell);
});

// Vela's built-in timeframe/style dropdowns live in the topbar but their menu + a
// hover tooltip share one trigger, which is fragile (a box pops where the menu opens
// and vanishes when the pointer chases it). We replace just those two dropdowns with
// our own click-only control: plain DOM, no hover handling, so it can't disappear.
const TIMEFRAMES: Array<[string, string]> = [
  ['1', '1m'], ['5', '5m'], ['15', '15m'], ['30', '30m'], ['60', '1h'],
  ['120', '2h'], ['240', '4h'], ['D', '1D'], ['W', '1W'], ['M', '1M'],
];
const PRICE_STYLES: Array<[string, string]> = [
  ['candles', 'Candles'], ['bars', 'Bars'], ['line', 'Line'],
  ['area', 'Area'], ['baseline', 'Baseline'], ['heikinashi', 'Heikin Ashi'],
];

const CONTROL_CSS = `
.vela-widget-tf-group, .vela-widget-style[aria-label^="Chart style"] { display: none !important; }
.vela-widget-panel-dataWindow, .vela-widget-panel-objects { display: none !important; }
.vct-dd { position: relative; display: inline-flex; align-items: center; }
.vct-btn { display: inline-flex; align-items: center; gap: 7px; height: 26px; padding: 0 9px;
  background: transparent; border: none; color: var(--vela-fg, #d1d4dc); font: inherit; font-size: 12px;
  border-radius: 6px; cursor: pointer; white-space: nowrap; }
.vct-btn:hover { background: var(--vela-hover, rgba(255,255,255,.08)); }
.vct-btn[aria-expanded='true'] { background: var(--vela-active, rgba(255,255,255,.12)); color: var(--vela-fg-bright, #fff); }
.vct-chev { color: var(--vela-fg-muted, #888); font-size: 9px; line-height: 1; }
.vct-panel { position: fixed; z-index: 2147483000; min-width: 116px; max-height: 60vh; overflow-y: auto;
  padding: 6px; background: var(--vela-surface, #1e222d); color: var(--vela-fg, #d1d4dc);
  border: 1px solid var(--vela-border-strong, #363a45); border-radius: 6px;
  box-shadow: 0 8px 28px rgba(0,0,0,.5); font-size: 13px; }
.vct-opt { display: block; width: 100%; text-align: left; padding: 7px 10px; background: transparent;
  border: none; color: inherit; font: inherit; font-size: 13px; border-radius: 4px; cursor: pointer; white-space: nowrap; }
.vct-opt:hover { background: var(--vela-hover, rgba(255,255,255,.08)); }
.vct-opt[data-current] { background: var(--vela-hover-strong, rgba(255,255,255,.14)); color: var(--vela-fg-bright, #fff); }
`;

type DropdownOptions = {
  items: Array<[string, string]>;
  getValue: () => string;
  onSelect: (value: string) => void;
};

function makeDropdown({ items, getValue, onSelect }: DropdownOptions) {
  const wrap = document.createElement('div');
  wrap.className = 'vct-dd';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'vct-btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  const label = document.createElement('span');
  const chev = document.createElement('span');
  chev.className = 'vct-chev';
  chev.textContent = '▼';
  btn.append(label, chev);

  const panel = document.createElement('div');
  panel.className = 'vct-panel';
  panel.hidden = true;
  panel.setAttribute('role', 'listbox');
  const labelOf = (v: string) => (items.find(([val]) => val === v) || [, v])[1];
  for (const [val, text] of items) {
    const opt = document.createElement('button');
    opt.type = 'button';
    opt.className = 'vct-opt';
    opt.dataset.value = val;
    opt.textContent = text;
    opt.addEventListener('click', () => { onSelect(val); close(); });
    panel.appendChild(opt);
  }
  document.body.appendChild(panel);
  wrap.appendChild(btn);

  let open = false;
  const onDocDown = (e: PointerEvent) => { if (!wrap.contains(e.target as Node) && !panel.contains(e.target as Node)) close(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  function position() {
    const r = btn.getBoundingClientRect();
    panel.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - panel.offsetWidth - 4))}px`;
    panel.style.top = `${r.bottom + 4}px`;
  }
  function close() {
    if (!open) return;
    open = false;
    panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close);
  }
  function show() {
    if (open) return;
    open = true;
    panel.hidden = false;
    position();
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
  }
  btn.addEventListener('click', () => (open ? close() : show()));

  let last: string | null = null;
  const sync = () => {
    const v = getValue();
    if (v === last) return;
    last = v;
    label.textContent = labelOf(v);
    for (const opt of panel.children as HTMLCollectionOf<HTMLButtonElement>) opt.toggleAttribute('data-current', opt.dataset.value === v);
  };
  sync();
  return { el: wrap, sync, close };
}

(function installCustomTopbarControls(workspace: any) {
  const style = document.createElement('style');
  style.textContent = CONTROL_CSS;
  document.head.appendChild(style);

  const activeCell = () => workspace.cells()[0];
  const tfDD = makeDropdown({
    items: TIMEFRAMES,
    getValue: () => activeCell()?.timeframe ?? 'D',
    onSelect: (v: string) => activeCell()?.setTimeframe(v),
  });
  const styleDD = makeDropdown({
    items: PRICE_STYLES,
    getValue: () => activeCell()?.priceStyle ?? 'candles',
    onSelect: (v: string) => activeCell()?.setPriceStyle(v),
  });

  const mount = () => {
    const bar = document.querySelector('.vela-widget-topbar');
    if (!bar) return;
    const tfGroup = bar.querySelector('.vela-widget-tf-group');
    if (tfGroup && !tfGroup.nextElementSibling?.classList.contains('vct-dd')) {
      tfGroup.insertAdjacentElement('afterend', tfDD.el);
    } else if (!bar.contains(tfDD.el)) {
      bar.appendChild(tfDD.el);
    }
    const styleBtn = bar.querySelector('.vela-widget-style');
    if (styleBtn && !styleBtn.nextElementSibling?.classList.contains('vct-dd')) {
      styleBtn.insertAdjacentElement('afterend', styleDD.el);
    } else if (!bar.contains(styleDD.el)) {
      bar.appendChild(styleDD.el);
    }
  };
  mount();
  workspace.on?.('cell:priceStyle', () => styleDD.sync());
  setInterval(() => {
    mount();
    tfDD.sync();
    styleDD.sync();
  }, 400);
})(ws);

installIndicatorEditor(ws);

// The agent column's UI. The backend is intentionally a thin contract so the runtime
// can be swapped later: POST /api/v1/agent { symbol, timeframe, messages } and answer
// with JSON { reply } or an SSE stream of { delta } / { text } frames.
function mountAgentPanel(ctx: any, body: HTMLElement) {
  const style = document.createElement('style');
  style.textContent = `
.vela-panel-agent .vela-panel-header { display: none !important; }
.vela-panel-agent .vela-panel-body { padding: 0; }
.vagent { display: flex; flex-direction: column; height: 100%; margin: 0; font-size: 13px; }
.vagent-ctx { display: flex; align-items: baseline; gap: 8px; padding: 10px 12px;
  border-bottom: 1px solid var(--vela-border, #2a2e39); }
.vagent-sym { font-weight: 600; color: var(--vela-fg-bright, #fff); }
.vagent-tf { color: var(--vela-fg-muted, #8a8f9c); }
.vagent-last { margin-left: auto; color: var(--vela-fg-bright, #fff); font-variant-numeric: tabular-nums; }
.vagent-config { margin: 10px 12px 0; padding: 8px 10px; border-radius: 6px; line-height: 1.5;
  background: rgba(240, 185, 11, .12); border: 1px solid rgba(240, 185, 11, .35);
  color: #f0b90b; font-size: 11px; white-space: pre-wrap; }
.vagent-config[hidden] { display: none !important; }
.vagent-config button { all: unset; cursor: pointer; margin-top: 5px; display: inline-block;
  padding: 2px 8px; border-radius: 4px; border: 1px solid rgba(240, 185, 11, .5); color: #f0b90b; }
.vagent-msgs { flex: 1; overflow-y: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.vagent-turn { display: flex; flex-direction: column; gap: 6px; }
.vagent-msg { max-width: 92%; padding: 7px 9px; border-radius: 7px; line-height: 1.45; white-space: pre-wrap;
  word-break: break-word; }
.vagent-msg.agent { background: var(--vela-hover, rgba(255,255,255,.06)); }
.vagent-msg.user { align-self: flex-end; background: rgba(41, 98, 255, .22); }
.vagent-msg.system { color: var(--vela-fg-muted, #8a8f9c); font-size: 12px; padding: 0 2px; }
.vagent-auto { display: flex; align-items: center; gap: 8px; margin: 0 12px 8px; padding: 8px 10px;
  border-radius: 6px; background: var(--vela-hover, rgba(255,255,255,.06)); color: var(--vela-fg, #d1d4dc);
  font-size: 12px; }
.vagent-dot { width: 7px; height: 7px; border-radius: 50%; background: #26a69a;
  box-shadow: 0 0 0 3px rgba(38, 166, 154, .15); flex: none; }
.vagent-dot[data-busy='1'] { background: #f0b90b; animation: vagent-pulse 1.2s ease-in-out infinite; }
@keyframes vagent-pulse { 50% { opacity: .35; } }
.vagent-system { border: 1px solid var(--vela-border, #2a2e39); border-radius: 6px; margin-bottom: 6px;
  background: rgba(41, 98, 255, .06); }
.vagent-system-global { margin: 10px 12px 0; flex: none; }
.vagent-system summary { cursor: pointer; padding: 5px 8px; color: var(--vela-fg-muted, #8a8f9c);
  font-size: 12px; user-select: none; }
.vagent-system-body { padding: 0 8px 7px; color: var(--vela-fg-muted, #8a8f9c); font-size: 11px;
  line-height: 1.4; white-space: pre-wrap; max-height: 240px; overflow-y: auto; }
.vagent-think { border: 1px solid var(--vela-border, #2a2e39); border-radius: 6px; margin-bottom: 6px;
  background: rgba(255, 255, 255, .03); }
.vagent-think summary { cursor: pointer; padding: 5px 8px; color: var(--vela-fg-muted, #8a8f9c);
  font-size: 12px; user-select: none; }
.vagent-think-body { padding: 0 8px 7px; color: var(--vela-fg-muted, #8a8f9c); font-size: 12px;
  line-height: 1.45; white-space: pre-wrap; max-height: 240px; overflow-y: auto; }
.vagent-answer { white-space: pre-wrap; }
.vagent-answer[data-streaming='1']::after { content: '▍'; margin-left: 1px; animation: vagent-caret 1s steps(2) infinite; }
@keyframes vagent-caret { 50% { opacity: 0; } }
.vagent-shot { display: block; margin-top: 6px; width: 100%; max-height: 180px; object-fit: contain;
  border-radius: 5px; border: 1px solid var(--vela-border-strong, #363a45); background: #0b0e11; }
.vagent-note { padding: 0 12px 8px; color: var(--vela-fg-muted, #8a8f9c); font-size: 11px; }
`;
  document.head.appendChild(style);
  body.style.padding = '0';

  const root = document.createElement('div');
  root.className = 'vagent';
  root.innerHTML = `
    <div class="vagent-config" hidden></div>
    <div class="vagent-msgs"></div>`;
  body.appendChild(root);

  const msgsEl = root.querySelector<HTMLElement>('.vagent-msgs')!;
  const configEl = root.querySelector<HTMLElement>('.vagent-config')!;
  const systemEl = document.createElement('details');
  systemEl.className = 'vagent-system vagent-system-global';
  systemEl.open = true;
  const systemSummary = document.createElement('summary');
  systemSummary.textContent = '系统提示词 · 加载中…';
  const systemBody = document.createElement('div');
  systemBody.className = 'vagent-system-body';
  systemBody.textContent = '正在读取当前标的与当日 K 线…';
  systemEl.append(systemSummary, systemBody);
  root.prepend(systemEl);

  const effortLabel = (effort?: string) => ({ low: '低', high: '高', max: '最高' } as Record<string, string>)[effort ?? ''] ?? effort ?? '';
  const setSystem = (content: string, meta: any = {}) => {
    const imageState = meta.vision ? ' · 截图已附' : meta.images ? ' · 截图未附' : '';
    const effort = effortLabel(meta.effort);
    systemSummary.textContent = `系统提示词 · ${(meta.symbol ?? '').split(':').pop()} ${meta.timeframe ?? ''} · ${meta.model ?? ''}${effort ? ` · 思考强度${effort}` : ''}${imageState}`;
    systemBody.textContent = content ?? '';
  };

  const history: Array<{ role: string; content: string }> = [];
  let agentConfigured: boolean | null = null;
  let configWarned = false;
  let busy = false;
  let chart: VelaChart | null = null;
  let offMarket: (() => void) | null = null;
  let queued: { text: string; bar: Bar } | null = null;
  let systemLoaded = false;
  let previewBusy = false;

  const loadAgentStatus = async () => {
    try {
      const data = await api.get('/agent/status');
      agentConfigured = Boolean(data.configured);
      if (agentConfigured) {
        configWarned = false;
        configEl.hidden = true;
      } else {
        configEl.replaceChildren();
        const text = document.createElement('div');
        text.textContent = '未检测到 DEEPSEEK_API_KEY。请先设置环境变量并重启应用：\nPowerShell: $env:DEEPSEEK_API_KEY="sk-..."\n永久设置: setx DEEPSEEK_API_KEY "sk-..."\n也可写入 data/agent.json 的 apiKey 字段。';
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.textContent = '重新检测';
        retry.addEventListener('click', loadAgentStatus);
        configEl.append(text, retry);
        configEl.hidden = false;
      }
    } catch {
      agentConfigured = false;
      configEl.hidden = true;
    }
  };
  void loadAgentStatus();

  const addMessage = (role: string, text: string) => {
    const el = document.createElement('div');
    el.className = `vagent-msg ${role}`;
    el.textContent = text;
    msgsEl.appendChild(el);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return el;
  };
  const bind = (next: VelaChart) => {
    offMarket?.();
    chart = next;
    systemLoaded = false;
    void loadSystemPreview();
    offMarket = chart.on('market:changed', () => {
      history.length = 0;
      queued = null;
      systemLoaded = false;
      void loadSystemPreview();
    });
  };

  const currentChart = () => {
    if (chart) return chart;
    try {
      return ctx.chart ?? null;
    } catch {
      return null;
    }
  };

  async function loadSystemPreview() {
    const current = currentChart();
    if (!current || previewBusy) return;
    previewBusy = true;
    try {
      const market = current.market;
      const params = new URLSearchParams({ symbol: market.symbol ?? '', timeframe: market.timeframe ?? '' });
      const data = await api.get(`/agent/system?${params}`);
      setSystem(data.content, data.meta);
      systemLoaded = true;
    } catch {
      /* keep the placeholder */
    } finally {
      previewBusy = false;
    }
  }

  const formatBarText = (bar: Bar) => {
    const time = new Date(bar.time).toLocaleTimeString('zh-CN', {
      timeZone: TIMEZONE, hour12: false, hour: '2-digit', minute: '2-digit',
    });
    const timeframe = chart?.market?.timeframe as string | undefined;
    const tf = (timeframe && TF_MAP[timeframe]) || timeframe || '';
    return `${time} ${tf} 收盘\nO ${bar.open}  H ${bar.high}  L ${bar.low}  C ${bar.close}  V ${bar.volume ?? 0}`;
  };

  const capture = (target: any) => {
    try {
      const canvas = target.renderer.screenshotCanvas?.();
      if (!canvas) return { images: [], preview: null };
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      const comma = dataUrl.indexOf(',');
      if (comma < 0) return { images: [], preview: null };
      return { images: [{ mime: 'image/jpeg', data: dataUrl.slice(comma + 1) }], preview: dataUrl };
    } catch {
      return { images: [], preview: null };
    }
  };

  const analyze = async (text: string, bar: Bar, target: VelaChart | null) => {
    if (!target) return;
    const shot = capture(target);
    const images = shot.images;
    const display = images.length > 0 ? `${text}\n（已采集当前图表截图）` : text;
    history.push({ role: 'user', content: display });

    // One turn: system context first (left), then the user bar (right) with its
    // screenshot thumbnail, then the agent's reasoning/answer (left).
    const turn = document.createElement('div');
    turn.className = 'vagent-turn';
    msgsEl.appendChild(turn);

    const userEl = document.createElement('div');
    userEl.className = 'vagent-msg user';
    const userText = document.createElement('div');
    userText.textContent = display;
    userEl.appendChild(userText);
    if (shot.preview) {
      const img = document.createElement('img');
      img.className = 'vagent-shot';
      img.src = shot.preview;
      img.alt = '图表截图';
      userEl.appendChild(img);
    }
    turn.appendChild(userEl);
    msgsEl.scrollTop = msgsEl.scrollHeight;

    busy = true;
    try {
      const market = target.market;
      const context = {
        last: bar.close,
        visibleRange: target.getVisibleRange(),
        indicators: target.inspect().indicators.map((item: any) => item.title),
      };
      const res = await fetch(`${API_BASE}/agent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          symbol: market.symbol,
          timeframe: market.timeframe,
          bar,
          context,
          images,
          messages: history.slice(-10),
        }),
      });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const payload = await res.json();
          if (payload?.message) detail = payload.message;
          else if (payload?.error) detail = payload.error;
        } catch {
          /* not JSON */
        }
        throw new Error(detail);
      }
      const type = res.headers.get('content-type') || '';
      if (type.includes('text/event-stream') && res.body) {
        const node = document.createElement('div');
        node.className = 'vagent-msg agent';
        const details = document.createElement('details');
        details.className = 'vagent-think';
        details.hidden = true;
        const summary = document.createElement('summary');
        summary.textContent = '深度思考';
        const thinkBody = document.createElement('div');
        thinkBody.className = 'vagent-think-body';
        details.append(summary, thinkBody);
        const answerEl = document.createElement('div');
        answerEl.className = 'vagent-answer';
        answerEl.dataset.streaming = '1';
        node.append(details, answerEl);
        turn.appendChild(node);
        msgsEl.scrollTop = msgsEl.scrollHeight;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let answer = '';
        let reasoning = '';
        let firstReasoning = true;
        let firstContent = true;
        const handleFrame = (frame: string) => {
          const line = frame.split('\n').find((l: string) => l.startsWith('data:'));
          if (!line) return;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') return;
          let parsed;
          try {
            parsed = JSON.parse(payload);
          } catch {
            answer += payload;
            answerEl.textContent = answer;
            return;
          }
          if (parsed.type === 'error') throw new Error(parsed.message || 'agent error');
          if (parsed.type === 'system') {
            setSystem(parsed.content, parsed.meta);
            return;
          }
          if (parsed.type === 'reasoning' && parsed.delta) {
            reasoning += parsed.delta;
            details.hidden = false;
            if (firstReasoning) {
              firstReasoning = false;
              details.open = true;
            }
            thinkBody.textContent = reasoning;
          } else if (parsed.type === 'content' && parsed.delta) {
            if (firstContent) {
              firstContent = false;
              details.open = false;
            }
            answer += parsed.delta;
            answerEl.textContent = answer;
          } else if (parsed.delta || parsed.text) {
            answer += parsed.delta ?? parsed.text;
            answerEl.textContent = answer;
          }
          msgsEl.scrollTop = msgsEl.scrollHeight;
        };
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let cut;
          while ((cut = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, cut).trim();
            buffer = buffer.slice(cut + 2);
            handleFrame(frame);
          }
        }
        delete answerEl.dataset.streaming;
        if (answer) history.push({ role: 'assistant', content: answer });
      } else {
        const data = await res.json();
        const reply = data.reply ?? data.text ?? '（空回复）';
        const replyEl = document.createElement('div');
        replyEl.className = 'vagent-msg agent';
        replyEl.textContent = reply;
        turn.appendChild(replyEl);
        history.push({ role: 'assistant', content: reply });
      }
    } catch (error) {
      for (const el of turn.querySelectorAll<HTMLElement>('.vagent-answer[data-streaming]')) delete el.dataset.streaming;
      const errEl = document.createElement('div');
      errEl.className = 'vagent-msg system';
      errEl.textContent = `Agent 请求失败：${error instanceof Error ? error.message : String(error)}`;
      turn.appendChild(errEl);
    } finally {
      busy = false;
      if (queued) {
        const next = queued;
        queued = null;
        void analyze(next.text, next.bar, currentChart());
      }
    }
  };

  const onClosedBar = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    const market = chart?.market;
    if (!detail || !market) return;
    const ticker = (market.symbol ?? '').split(':').pop();
    const tf = TF_MAP[market.timeframe] || market.timeframe;
    if (detail.symbol !== ticker || detail.timeframe !== tf) return;
    if (agentConfigured === false) {
      if (!configWarned) {
        configWarned = true;
        addMessage('system', '未检测到 DEEPSEEK_API_KEY，自动分析已暂停。设置环境变量后重启应用，或配置 data/agent.json。');
      }
      return;
    }
    const text = formatBarText(detail.bar);
    if (busy) {
      queued = { text, bar: detail.bar };
      return;
    }
    void analyze(text, detail.bar, chart);
  };
  window.addEventListener('vela:bar-close', onClosedBar);

  const sync = () => {
    const next = currentChart();
    if (next && next !== chart) bind(next);
    else if (chart && !systemLoaded) void loadSystemPreview();
  };
  sync();
  const timer = setInterval(sync, 600);
  return {
    onChart: bind,
    destroy() {
      clearInterval(timer);
      window.removeEventListener('vela:bar-close', onClosedBar);
      offMarket?.();
      style.remove();
    },
  };
}

(window as any).ws = ws;
