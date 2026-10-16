import { VelaWorkspace, setLocale, registerRendererDefaults } from '@luxalgo/vela/workspace';

import { PineEngine } from '@luxalgo/vela-pinets';

const TF_MAP = {
  '1': '1m', '5': '5m', '15': '15m', '30': '30m',
  '60': '1h', '120': '2h', '240': '4h',
  D: '1d', W: '1w', M: '1M',
  '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1h', '2h': '2h', '4h': '4h',
  '1d': '1d', '1w': '1w', '1M': '1M',
};

class LongbridgeProvider {
  async getBars(ticker, timeframe, range) {
    const tf = TF_MAP[timeframe] || '1d';
    const params = new URLSearchParams({
      symbol: ticker,
      tf,
      count: String(range?.limit || 500),
    });
    if (range?.from != null) params.set('from', String(range.from));
    if (range?.to != null) params.set('to', String(range.to));
    let lastErr;
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(`/api/bars?${params}`);
        if (!r.ok) throw new Error(`longbridge ${r.status}`);
        return (await r.json()).bars;
      } catch (e) {
        lastErr = e;
        await new Promise((res) => setTimeout(res, 700 * (i + 1)));
      }
    }
    throw lastErr;
  }

  async listSymbols() {
    const r = await fetch('/api/symbols');
    const rows = await r.json();
    return rows.map((s) => ({ ticker: s.ticker, description: s.description, type: s.type }));
  }

  info() {
    return {
      name: 'longbridge',
      displayName: '长桥',
      supportedTimeframes: Object.keys(TF_MAP),
      capabilities: { enumerate: true, stream: false, symbolInfo: false },
    };
  }
}

const PERSIST_KEY = 'vela-client-longbridge';
const TIMEFRAME_FAVORITES = ['1', '5', '15', '60', '240', 'D', 'W', 'M'];
// History depth (bars) the chart loads + lets Vela backfill. A restored persisted cell
// carries NO `bars`, so it would boot at Vela's 500 default and never scroll back — seed
// it here too, mirroring the workspace default below.
const DEEP_BARS = 20000;
// Display timezone for the axis / bottom bar (IANA). The persisted workspace doc
// carries its own `timezone`, so we force it here too.
const TIMEZONE = 'America/New_York';

// Vela draws the favorite timeframes as one-click switch chips in the topbar
// (and stars in the dropdown). The set only comes from the PERSISTED state, so
// we seed/merge it here — otherwise the topbar hides every timeframe behind the
// dropdown menu.
const storage = {
  get(key) {
    let raw = null;
    try { raw = localStorage.getItem(key); } catch { return null; }
    if (key !== PERSIST_KEY) return raw;
    if (!raw) return JSON.stringify({ version: 1, layout: '1', timezone: TIMEZONE, timeframeFavorites: TIMEFRAME_FAVORITES });
    try {
      const doc = JSON.parse(raw);
      doc.timezone = TIMEZONE;
      if (!Array.isArray(doc.timeframeFavorites) || doc.timeframeFavorites.length === 0) {
        doc.timeframeFavorites = TIMEFRAME_FAVORITES;
      }
      if (Array.isArray(doc.charts)) {
        for (const c of doc.charts) {
          if (typeof c.bars !== 'number' || c.bars <= 0) c.bars = DEEP_BARS;
        }
      }
      return JSON.stringify(doc);
    } catch {
      return raw;
    }
  },
  set(key, value) { try { localStorage.setItem(key, value); } catch {} },
  remove(key) { try { localStorage.removeItem(key); } catch {} },
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
  symbol: 'longbridge:AAPL.US',
  timeframe: 'D',
  bars: DEEP_BARS,
  providers: { longbridge: () => new LongbridgeProvider() },
  engines: { pine: () => new PineEngine() },
  indicators: '/api/indicators.json',
  timezone: TIMEZONE,
  persist: PERSIST_KEY,
  storage,
});

// The persisted doc's own `timezone` wins on boot, so force the display zone here too.
ws.setTimezone(TIMEZONE);

// Vela's built-in timeframe/style dropdowns live in the topbar but their menu + a
// hover tooltip share one trigger, which is fragile (a box pops where the menu opens
// and vanishes when the pointer chases it). We replace just those two dropdowns with
// our own click-only control: plain DOM, no hover handling, so it can't disappear.
const TIMEFRAMES = [
  ['1', '1m'], ['5', '5m'], ['15', '15m'], ['30', '30m'], ['60', '1h'],
  ['120', '2h'], ['240', '4h'], ['D', '1D'], ['W', '1W'], ['M', '1M'],
];
const PRICE_STYLES = [
  ['candles', 'Candles'], ['bars', 'Bars'], ['line', 'Line'],
  ['area', 'Area'], ['baseline', 'Baseline'], ['heikinashi', 'Heikin Ashi'],
];

const CONTROL_CSS = `
.vela-widget-tf-group, .vela-widget-style[aria-label^="Chart style"] { display: none !important; }
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

function makeDropdown({ items, getValue, onSelect }) {
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
  const labelOf = (v) => (items.find(([val]) => val === v) || [, v])[1];
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
  const onDocDown = (e) => { if (!wrap.contains(e.target) && !panel.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
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

  let last = null;
  const sync = () => {
    const v = getValue();
    if (v === last) return;
    last = v;
    label.textContent = labelOf(v);
    for (const opt of panel.children) opt.toggleAttribute('data-current', opt.dataset.value === v);
  };
  sync();
  return { el: wrap, sync, close };
}

(function installCustomTopbarControls(workspace) {
  const style = document.createElement('style');
  style.textContent = CONTROL_CSS;
  document.head.appendChild(style);

  const activeCell = () => workspace.cells()[0];
  const tfDD = makeDropdown({
    items: TIMEFRAMES,
    getValue: () => activeCell()?.timeframe ?? 'D',
    onSelect: (v) => activeCell()?.setTimeframe(v),
  });
  const styleDD = makeDropdown({
    items: PRICE_STYLES,
    getValue: () => activeCell()?.priceStyle ?? 'candles',
    onSelect: (v) => activeCell()?.setPriceStyle(v),
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

window.ws = ws;
