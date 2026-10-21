import './error-boundary.ts';
import { VelaWorkspace, setLocale, registerRendererDefaults } from '@luxalgo/vela/workspace';
import { registerSidePanel } from '@luxalgo/vela/widget';
import { registerIcon, svg16 } from '@luxalgo/vela/ui';
import { PineWorkerEngine } from '@luxalgo/vela-pinets';
import { installIndicatorEditor } from './indicator-editor.ts';
import { registerBacktestPanel } from './backtest-panel.ts';
import { api } from './api.ts';
import { LongbridgeProvider, INITIAL_BARS } from './provider.ts';
import { DEFAULT_STUDIES, PERSIST_KEY, TIMEZONE, storage } from './storage.ts';
import { installSlidingHistory } from './sliding.ts';
import { installCustomTopbarControls } from './topbar.ts';
import { mountAgentPanel } from './agent-panel.ts';

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

async function loadIndicators() {
  const list = await api.get<Array<{ name: string; enabled?: boolean }>>('/indicators.json');
  if (!Array.isArray(list)) throw new Error('invalid indicators manifest');
  return list.map((entry: { name: string }) =>
    entry.name === DEFAULT_STUDIES.manifest ? { ...entry, enabled: true } : entry,
  );
}

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
  indicators: loadIndicators,
  topbar: { right: ['actions', 'panels'] },
  timezone: TIMEZONE,
  persist: PERSIST_KEY,
  storage,
});

ws.setTimezone(TIMEZONE);

installSlidingHistory(ws);
installCustomTopbarControls(ws);
installIndicatorEditor(ws);

(window as any).ws = ws;
