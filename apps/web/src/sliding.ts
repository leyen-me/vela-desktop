import {
  INITIAL_BARS,
  MAX_BARS,
  SLIDE_BARS,
  TF_MAP,
  TF_MS,
  exhaustedMarkets,
  newestByMarket,
  oldestByMarket,
} from './provider.ts';
import type { VelaCell } from './types.ts';

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

export function installSlidingHistory(ws: any): void {
  for (const cell of ws.cells()) installSliding(cell);
  ws.on('cell:created', ({ id }: { id: string }) => {
    const cell = ws.cell(id);
    if (cell) installSliding(cell);
  });
}
