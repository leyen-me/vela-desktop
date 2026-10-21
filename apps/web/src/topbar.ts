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

export function makeDropdown({ items, getValue, onSelect }: DropdownOptions) {
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

export function installCustomTopbarControls(workspace: any): void {
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
}

