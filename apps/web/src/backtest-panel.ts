import { registerSidePanel } from '@luxalgo/vela/widget';
import { registerIcon, svg16 } from '@luxalgo/vela/ui';
import { API_BASE, api } from './api.ts';
import { escapeHtml } from './html.ts';

type RunEvent = {
    type: string;
    phase?: string;
    plan?: { open: number; flattenAt: number; close: number; isEarlyClose: boolean; decisionTimes: number[] };
    bars?: number;
    event?: Record<string, unknown>;
    asOf?: number;
    entryQuota?: { limit: number; used: number; reserved: number; available: number };
    position?: { qty: number; avgPrice?: number; unrealizedPnl?: number } | null;
    account?: { equity: number; cash: number; buyingPower: number; realizedPnl?: number; unrealizedPnl?: number };
    orders?: Array<Record<string, unknown>>;
    lastPrice?: number;
    limits?: Record<string, number>;
    systemPrompt?: string;
    cancelled?: boolean;
    runId?: string;
    action?: 'pause' | 'resume' | 'stop' | 'cancel';
    report?: {
        metrics: Record<string, number>;
        session: { date: string; isEarlyClose: boolean };
        closedTrades: Array<Record<string, number | string>>;
        equityCurve: Array<{ time: number; equity: number }>;
        orders: Array<Record<string, unknown>>;
        fills: Array<{ time: number; barOpenTime?: number; price: number; qty: number; side: 'buy' | 'sell'; entry: boolean }>;
        stopped?: boolean;
        stoppedAt?: number;
        blockedOrders: Array<Record<string, unknown>>;
        decisions: number;
    };
    message?: string;
};

const NY = 'America/New_York';

function todayInNY(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: NY, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function previousWeekday(): string {
    const date = new Date(`${todayInNY()}T12:00:00Z`);
    do {
        date.setUTCDate(date.getUTCDate() - 1);
    } while (date.getUTCDay() === 0 || date.getUTCDay() === 6);
    return date.toISOString().slice(0, 10);
}

function etClock(ms: number): string {
    return new Intl.DateTimeFormat('en-GB', {
        timeZone: NY, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date(ms));
}

function money(value: number): string {
    return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pct(value: number): string {
    return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function chartTimeframe(value: string): string {
    return ({ '1': '1m', '5': '5m', '15': '15m', '30': '30m', '60': '1h', '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h' } as Record<string, string>)[value] || '';
}

function addStyle(): () => void {
    const style = document.createElement('style');
    style.textContent = `
.vbt { display:flex; flex-direction:column; height:100%; margin:0; font-size:12px; color:var(--vela-fg,#d1d4dc); }
.vbt-form { padding:10px 12px; display:grid; grid-template-columns:1fr 1fr; gap:7px; border-bottom:1px solid var(--vela-border,#2a2e39); }
.vbt-field { display:flex; flex-direction:column; gap:3px; }
.vbt-field.wide { grid-column:1 / -1; }
.vbt-field span { color:var(--vela-fg-muted,#8a8f9c); font-size:11px; }
.vbt-field input, .vbt-field select { width:100%; box-sizing:border-box; padding:5px 7px; border-radius:5px; border:1px solid var(--vela-border,#2a2e39); background:var(--vela-bg,#131722); color:var(--vela-fg,#d1d4dc); font-size:12px; }
.vbt-row { display:flex; gap:6px; grid-column:1 / -1; }
.vbt-row button { flex:1 1 auto; padding:7px 6px; border-radius:5px; border:0; background:#2962ff; color:#fff; font-weight:600; cursor:pointer; white-space:nowrap; font-size:11px; }
.vbt-row button:disabled { opacity:.5; cursor:default; }
.vbt-row button.secondary { background:transparent; border:1px solid var(--vela-border,#2a2e39); color:var(--vela-fg-muted,#8a8f9c); }
.vbt-body { flex:1; overflow:auto; padding:10px 12px 20px; }
.vbt-metrics { display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:10px; }
.vbt-metric { border:1px solid var(--vela-border,#2a2e39); border-radius:6px; padding:6px 8px; }
.vbt-metric b { display:block; font-size:15px; font-variant-numeric:tabular-nums; }
.vbt-metric span { color:var(--vela-fg-muted,#8a8f9c); font-size:10px; }
.vbt-up { color:#26a69a; } .vbt-down { color:#ef5350; }
.vbt-chart { width:100%; height:110px; margin-bottom:10px; }
.vbt-loghead { display:flex; align-items:center; justify-content:space-between; margin:8px 0 4px; color:var(--vela-fg-muted,#8a8f9c); font-size:11px; }
.vbt-loghead button { all:unset; cursor:pointer; padding:2px 6px; border-radius:4px; border:1px solid var(--vela-border,#2a2e39); color:var(--vela-fg-muted,#8a8f9c); font-size:10px; }
.vbt-loghead button:hover { color:var(--vela-fg,#d1d4dc); }
.vbt-context { margin:0 12px 8px; padding:8px 10px; border:1px solid var(--vela-border,#2a2e39); border-radius:8px;
  background:rgba(255,255,255,.025); color:var(--vela-fg-muted,#8a8f9c); font-size:11px; line-height:1.55; }
.vbt-context b { color:var(--vela-fg,#d1d4dc); font-weight:600; }
.vbt-status { margin-top:6px; color:var(--vela-fg-muted,#8a8f9c); font-size:11px; display:flex; align-items:center; gap:6px; }
.vbt-status[hidden] { display:none; }
.vbt-status[data-busy='1']::before { content:''; width:6px; height:6px; border-radius:50%; background:#f0b90b; animation:vbt-pulse 1.2s ease-in-out infinite; }
@keyframes vbt-pulse { 50% { opacity:.3; } }
.vbt-sys { margin-top:6px; border-top:1px solid rgba(255,255,255,.06); padding-top:5px; }
.vbt-sys[hidden] { display:none; }
.vbt-sys summary { cursor:pointer; color:var(--vela-fg-muted,#8a8f9c); font-size:10px; list-style:none; }
.vbt-sys summary::-webkit-details-marker { display:none; }
.vbt-sys summary::before { content:'▸ '; }
.vbt-sys[open] summary::before { content:'▾ '; }
.vbt-sys pre { margin:5px 0 0; max-height:220px; overflow:auto; white-space:pre-wrap; word-break:break-word;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:10px; line-height:1.5; color:var(--vela-fg-muted,#8a8f9c); }
.vbt-log:empty::before { content:'等待回测开始'; margin:auto; color:var(--vela-fg-muted,#8a8f9c); font-size:11px; }
.vbt-errors { display:flex; flex-direction:column; gap:4px; border:1px solid var(--vela-border,#2a2e39); border-radius:6px; padding:6px 8px; }
.vbt-errors .vbt-note { text-align:left; }
.vbt-log { border:1px solid var(--vela-border,#2a2e39); border-radius:8px; padding:10px; max-height:420px; overflow:auto;
  display:flex; flex-direction:column; gap:12px; font-size:11px; line-height:1.55; color:var(--vela-fg-muted,#8a8f9c);
  user-select:text; cursor:text; }
.vbt-note { white-space:pre-wrap; padding:0 4px; text-align:center; font-size:10.5px; color:var(--vela-fg-muted,#8a8f9c); }

.vbt-turn { display:flex; flex-direction:column; gap:8px; }
.vbt-msg { max-width:90%; padding:8px 11px; border-radius:12px; font-size:12px; line-height:1.55; }
.vbt-msg.user { align-self:flex-end; background:linear-gradient(135deg, rgba(41,98,255,.28), rgba(41,98,255,.14));
  border:1px solid rgba(41,98,255,.4); border-top-right-radius:4px; color:var(--vela-fg,#d1d4dc); }
.vbt-msg.agent { align-self:flex-start; background:rgba(255,255,255,.045); border:1px solid rgba(255,255,255,.06);
  border-top-left-radius:4px; color:var(--vela-fg,#d1d4dc); }
.vbt-msg-head { color:var(--vela-fg-muted,#8a8f9c); font-size:10px; margin-bottom:3px; }
.vbt-input { margin-top:6px; border-top:1px solid rgba(255,255,255,.08); padding-top:4px; }
.vbt-input summary { cursor:pointer; color:var(--vela-fg-muted,#8a8f9c); font-size:10px; list-style:none; }
.vbt-input summary::-webkit-details-marker { display:none; }
.vbt-input summary::before { content:'▸ '; }
.vbt-input[open] summary::before { content:'▾ '; }
.vbt-input pre { margin:4px 0 0; max-height:180px; overflow:auto; white-space:pre-wrap; word-break:break-word;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:10px; line-height:1.45; color:var(--vela-fg-muted,#8a8f9c); }
.vbt-content { white-space:pre-wrap; color:var(--vela-fg,#d1d4dc); font-size:12px; line-height:1.55; min-height:1px; }
.vbt-content:empty::before { content:'正在分析…'; color:var(--vela-fg-muted,#8a8f9c); }
.vbt-details { margin-top:6px; border:1px solid var(--vela-border,#2a2e39); border-radius:6px; padding:2px 6px; background:rgba(0,0,0,.12); }
.vbt-details summary { cursor:pointer; color:var(--vela-fg-muted,#8a8f9c); font-size:10px; padding:2px 0; }
.vbt-detail-body { white-space:pre-wrap; color:var(--vela-fg-muted,#8a8f9c); font-size:11px; max-height:180px; overflow:auto; padding-bottom:4px; }
.vbt-tool { white-space:pre-wrap; padding:1px 0; }
.vbt-tool.err { color:#ef5350; }
.vbt-visible-error { margin-top:5px; color:#ef5350; white-space:pre-wrap; }
.vbt-finish { margin-top:5px; padding:4px 6px; border-radius:4px; background:var(--vela-hover,rgba(255,255,255,.05)); white-space:pre-wrap; color:var(--vela-fg,#d1d4dc); }
.vbt-log b { color:var(--vela-fg,#d1d4dc); font-weight:600; }
.vbt-table { width:100%; border-collapse:collapse; font-size:11px; margin-top:8px; }
.vbt-table th, .vbt-table td { padding:4px 3px; border-bottom:1px solid rgba(255,255,255,.06); text-align:right; }
.vbt-table th:first-child, .vbt-table td:first-child { text-align:left; }
.vbt-table th { color:var(--vela-fg-muted,#8a8f9c); font-weight:500; }
.vbt-empty { color:var(--vela-fg-muted,#8a8f9c); font-size:11px; padding:6px 0; }
`;
    document.head.appendChild(style);
    return () => style.remove();
}

function renderEquity(container: HTMLElement, points: Array<{ time: number; equity: number }>): void {
    if (points.length < 2) {
        container.innerHTML = '';
        return;
    }
    const width = 340;
    const height = 110;
    const values = points.map((point) => point.equity);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = Math.max(1e-9, max - min);
    const step = width / (points.length - 1);
    const path = points.map((point, index) => {
        const x = index * step;
        const y = height - ((point.equity - min) / span) * (height - 8) - 4;
        return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const up = values[values.length - 1] >= values[0];
    container.innerHTML = `<svg class="vbt-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
      <path d="${path}" fill="none" stroke="${up ? '#26a69a' : '#ef5350'}" stroke-width="1.6"/>
    </svg>`;
}

export function registerBacktestPanel(): void {
    registerIcon('backtest', svg16('<path d="M6 1.5h4M6.5 1.5v4.2L3.2 12a1.2 1.2 0 0 0 1 1.8h7.6a1.2 1.2 0 0 0 1-1.8L9.5 5.7V1.5"/><path d="M5 9h6"/>'));
    registerSidePanel({
        id: 'backtest',
        title: 'AI 单日回测',
        icon: 'backtest',
        order: 25,
        width: 400,
        resizable: true,
        minWidth: 340,
        maxWidth: 620,
        mount(ctx, body) {
            const removeStyle = addStyle();
            body.style.padding = '0';
            const root = document.createElement('div');
            root.className = 'vbt';
            root.innerHTML = `
              <div class="vbt-form">
                <label class="vbt-field"><span>交易日</span><input data-k="date" type="date"></label>
                <label class="vbt-field"><span>仓位 %</span><input data-k="size" type="number" min="1" max="100" step="1" value="80"></label>
                <label class="vbt-field"><span>每日开仓上限</span><input data-k="entries" type="number" min="0" step="1" value="2"></label>
                <label class="vbt-field"><span>初始资金</span><input data-k="capital" type="number" min="1000" step="1000" value="100000"></label>
                <div class="vbt-row">
                  <button data-k="run" type="button" style="flex:2">开始回测</button>
                  <button data-k="plan" class="secondary" type="button">检查时段</button>
                </div>
                <div class="vbt-row">
                  <button data-k="pause" class="secondary" type="button" hidden disabled>暂停</button>
                  <button data-k="stop" class="secondary" type="button" hidden>停止</button>
                  <button data-k="cancel" class="secondary" type="button" hidden>退出回测</button>
                </div>
              </div>
              <div class="vbt-body">
                <div class="vbt-context">
                  <div data-k="context">选择交易日并开始回测。</div>
                  <div class="vbt-status" data-k="status" hidden></div>
                  <details class="vbt-sys" data-k="syswrap" hidden><summary>系统提示词</summary><pre data-k="sys"></pre></details>
                </div>
                <div data-k="summary"></div>
                <div data-k="equity"></div>
                <div class="vbt-log" data-k="chat"></div>
                <div data-k="logwrap" hidden>
                  <div class="vbt-loghead"><span>运行日志</span><button data-k="copy" type="button">复制日志</button></div>
                  <div class="vbt-errors" data-k="log"></div>
                </div>
                <div data-k="trades"></div>
              </div>`;
            body.appendChild(root);

            const get = <T extends HTMLElement>(key: string): T => root.querySelector(`[data-k="${key}"]`) as T;
            const date = get<HTMLInputElement>('date');
            const size = get<HTMLInputElement>('size');
            const entries = get<HTMLInputElement>('entries');
            const capital = get<HTMLInputElement>('capital');
            const runButton = get<HTMLButtonElement>('run');
            const planButton = get<HTMLButtonElement>('plan');
            const pauseButton = get<HTMLButtonElement>('pause');
            const stopButton = get<HTMLButtonElement>('stop');
            const cancelButton = get<HTMLButtonElement>('cancel');
            const copyButton = get<HTMLButtonElement>('copy');
            const contextEl = get<HTMLDivElement>('context');
            const statusEl = get<HTMLDivElement>('status');
            const chatEl = get<HTMLDivElement>('chat');
            const logWrap = get<HTMLDivElement>('logwrap');
            const sysWrap = get<HTMLDetailsElement>('syswrap');
            const sysEl = get<HTMLPreElement>('sys');
            const summary = get<HTMLDivElement>('summary');
            const equity = get<HTMLDivElement>('equity');
            const log = get<HTMLDivElement>('log');
            const trades = get<HTMLDivElement>('trades');

            date.value = previousWeekday();
            let busy = false;
            let paused = false;
            let currentRunId = '';
            let abort: AbortController | null = null;
            let cancellationTimer: ReturnType<typeof setTimeout> | null = null;
            let currentSymbol = '';
            let currentTimeframe = '';
            let offMarket: (() => void) | null = null;

            type ChartLike = { market?: { symbol?: string; timeframe?: string }; on?: (event: 'market:changed', cb: () => void) => () => void };

            const setDisabled = () => {
                const unavailable = !currentSymbol || !currentTimeframe;
                const reason = !currentSymbol
                    ? '未连接到图表'
                    : !currentTimeframe
                        ? '当前图表周期不支持，请切换到 1m–1h'
                        : '';
                runButton.disabled = busy || unavailable;
                planButton.disabled = busy || unavailable;
                runButton.title = reason;
                planButton.title = reason;
            };

            const syncFromChart = (chart?: ChartLike) => {
                let symbol = '';
                let timeframe = '';
                try {
                    symbol = chart?.market?.symbol || ctx.symbol || '';
                    timeframe = chart?.market?.timeframe || ctx.timeframe || '';
                } catch {
                    /* no active chart */
                }
                const ticker = symbol.includes(':') ? (symbol.split(':').pop() || symbol) : symbol;
                const mapped = chartTimeframe(String(timeframe));
                currentSymbol = ticker;
                currentTimeframe = mapped;
                setDisabled();
            };

            const bindChart = (chart?: ChartLike) => {
                offMarket?.();
                offMarket = chart?.on?.('market:changed', () => syncFromChart(chart)) ?? null;
                syncFromChart(chart);
            };

            const setStatus = (text?: string, spinning = false) => {
                const value = (text ?? '').trim();
                statusEl.textContent = value;
                statusEl.dataset.busy = spinning ? '1' : '0';
                statusEl.hidden = value.length === 0;
            };
            const appendLog = (html: string) => {
                logWrap.hidden = false;
                const row = document.createElement('div');
                row.className = 'vbt-note';
                row.innerHTML = html;
                log.appendChild(row);
                while (log.childElementCount > 260) log.firstElementChild?.remove();
                chatEl.scrollTop = chatEl.scrollHeight;
            };

            type AgentTurn = {
                root: HTMLDivElement;
                content: HTMLDivElement;
                think: HTMLDetailsElement;
                thinkBody: HTMLDivElement;
                tools: HTMLDetailsElement;
                toolsBody: HTMLDivElement;
                toolCount: number;
                toolErrors: number;
            };
            let currentTurn: AgentTurn | null = null;

            const beginTurn = (event: RunEvent) => {
                const asOf = event.asOf;
                const quota = event.entryQuota;
                const position = event.position;
                const account = event.account;
                const orders = event.orders ?? [];
                const turn = document.createElement('div');
                turn.className = 'vbt-turn';
                turn.innerHTML = `<div class="vbt-msg user">
                    <div class="vbt-msg-head">K 线收盘${asOf ? ` · ${etClock(asOf)}` : ''}</div>
                    <div class="vbt-msg-body"></div>
                    <details class="vbt-input"><summary>本轮输入</summary><pre></pre></details>
                  </div>
                  <div class="vbt-msg agent">
                    <div class="vbt-msg-head">AI 决策</div>
                    <div class="vbt-content"></div>
                    <details class="vbt-details vbt-think" hidden><summary>思考过程</summary><div class="vbt-detail-body"></div></details>
                    <details class="vbt-details vbt-tools" hidden><summary>工具调用 (0)</summary><div class="vbt-detail-body"></div></details>
                  </div>`;
                const userBody = turn.querySelector('.vbt-msg.user .vbt-msg-body') as HTMLDivElement;
                const lines = [
                    `价格 ${event.lastPrice ?? '?'} · 可开仓 ${quota?.available ?? '?'}/${quota?.limit ?? '?'} · 持仓 ${position?.qty ?? 0}`,
                ];
                if (account) {
                    lines.push(`权益 $${money(account.equity)} · 现金 $${money(account.cash)} · 购买力 $${money(account.buyingPower)}`);
                }
                lines.push(`挂单 ${orders.length}`);
                userBody.textContent = lines.join('\n');
                const input = turn.querySelector('.vbt-msg.user .vbt-input pre') as HTMLPreElement;
                input.textContent = JSON.stringify({
                    asOf: asOf ? new Date(asOf).toISOString() : null,
                    lastPrice: event.lastPrice,
                    account,
                    position,
                    workingOrders: orders,
                    entryQuota: quota,
                    limits: event.limits,
                    closedBars: event.bars,
                }, null, 2);
                const root = turn.querySelector('.vbt-msg.agent') as HTMLDivElement;
                chatEl.appendChild(turn);
                currentTurn = {
                    root,
                    content: root.querySelector('.vbt-content') as HTMLDivElement,
                    think: root.querySelector('.vbt-think') as HTMLDetailsElement,
                    thinkBody: root.querySelector('.vbt-think .vbt-detail-body') as HTMLDivElement,
                    tools: root.querySelector('.vbt-tools') as HTMLDetailsElement,
                    toolsBody: root.querySelector('.vbt-tools .vbt-detail-body') as HTMLDivElement,
                    toolCount: 0,
                    toolErrors: 0,
                };
                chatEl.scrollTop = chatEl.scrollHeight;
            };
            const scrollLog = () => {
                chatEl.scrollTop = chatEl.scrollHeight;
            };
            const appendReasoning = (delta: string) => {
                if (!currentTurn || !delta) return;
                currentTurn.think.hidden = false;
                currentTurn.thinkBody.textContent += delta;
                scrollLog();
            };
            const appendContent = (delta: string) => {
                if (!currentTurn || !delta) return;
                currentTurn.content.textContent += delta;
                scrollLog();
            };
            const appendAssistant = (content: string) => {
                if (!currentTurn || !content) return;
                if (!currentTurn.content.textContent) currentTurn.content.textContent = content;
                scrollLog();
            };
            const appendToolCall = (name: string, args: unknown) => {
                if (!currentTurn) return;
                currentTurn.tools.hidden = false;
                currentTurn.toolCount += 1;
                const row = document.createElement('div');
                row.className = 'vbt-tool';
                row.textContent = `→ ${name} ${JSON.stringify(args ?? {}).slice(0, 600)}`;
                currentTurn.toolsBody.appendChild(row);
                (currentTurn.tools.querySelector('summary') as HTMLElement).textContent = `工具调用 (${currentTurn.toolCount}${currentTurn.toolErrors ? `, ${currentTurn.toolErrors} 失败` : ''})`;
                scrollLog();
            };
            const appendToolResult = (name: string, result: { ok?: boolean; error?: { message?: string } } | undefined) => {
                if (!currentTurn) return;
                const failed = result?.ok === false;
                if (failed) currentTurn.toolErrors += 1;
                const row = document.createElement('div');
                row.className = `vbt-tool${failed ? ' err' : ''}`;
                row.textContent = failed
                    ? `← ${name} 失败：${result?.error?.message ?? 'rejected'}`
                    : `← ${name} ok`;
                currentTurn.toolsBody.appendChild(row);
                if (failed) {
                    const visible = document.createElement('div');
                    visible.className = 'vbt-visible-error';
                    visible.textContent = `工具失败 ${name}：${result?.error?.message ?? 'rejected'}`;
                    currentTurn.content.appendChild(visible);
                }
                (currentTurn.tools.querySelector('summary') as HTMLElement).textContent = `工具调用 (${currentTurn.toolCount}${currentTurn.toolErrors ? `, ${currentTurn.toolErrors} 失败` : ''})`;
                scrollLog();
            };
            const appendFinish = (summary: string) => {
                if (!currentTurn || !summary) return;
                if (!currentTurn.content.textContent) {
                    currentTurn.content.textContent = summary;
                } else {
                    const finish = document.createElement('div');
                    finish.className = 'vbt-finish';
                    finish.textContent = summary;
                    currentTurn.root.appendChild(finish);
                }
                scrollLog();
            };
            const appendTurnError = (message: string) => {
                if (!currentTurn) {
                    appendLog(`<span class="vbt-down">${message}</span>`);
                    return;
                }
                const row = document.createElement('div');
                row.className = 'vbt-tool err';
                row.textContent = `错误：${message}`;
                currentTurn.content.appendChild(row);
                scrollLog();
            };
            const setContext = (html: string) => {
                contextEl.innerHTML = html;
            };
            const setSystemPrompt = (text?: string) => {
                const value = (text ?? '').trim();
                sysEl.textContent = value;
                sysWrap.hidden = value.length === 0;
            };
            const clear = () => {
                summary.innerHTML = '';
                equity.innerHTML = '';
                trades.innerHTML = '';
                chatEl.innerHTML = '';
                log.innerHTML = '';
                logWrap.hidden = true;
                setContext('选择交易日并开始回测。');
                setSystemPrompt('');
                setStatus('');
                currentTurn = null;
            };
            const setBusy = (next: boolean) => {
                busy = next;
                setDisabled();
                runButton.textContent = next ? '回测中…' : '开始回测';
                pauseButton.hidden = !next;
                stopButton.hidden = !next;
                stopButton.textContent = '停止';
                stopButton.disabled = false;
                pauseButton.textContent = '暂停';
                pauseButton.disabled = true;
                if (!next) {
                    paused = false;
                    currentRunId = '';
                }
                cancelButton.textContent = next ? '取消回测' : '退出回测';
                cancelButton.hidden = !next && !replayPlan;
                cancelButton.disabled = false;
            };

            let replayPlan: { open: number; close: number } | null = null;
            const getChart = () => {
                try {
                    return ctx.chart;
                } catch {
                    return null;
                }
            };
            const revealDecisionBar = () => {
                const chart = getChart();
                if (!chart?.replay.state.active) return;
                chart.replay.step();
            };
            const revealSessionEnd = () => {
                const chart = getChart();
                if (!chart || !replayPlan) return;
                let guard = 0;
                while (guard++ < 10_000) {
                    const state = chart.replay.state;
                    if (!state.active || state.nextTime == null || state.nextTime >= replayPlan.close) break;
                    if (!chart.replay.step()) break;
                }
                cancelButton.hidden = false;
                cancelButton.textContent = '退出回测';
            };
            let aiMarkerIds: string[] = [];
            const clearTradeMarkers = () => {
                const chart = getChart();
                if (!chart?.drawings.supported) {
                    aiMarkerIds = [];
                    return;
                }
                for (const id of aiMarkerIds) chart.drawings.remove(id);
                aiMarkerIds = [];
            };
            const addTradeMarkers = (report: NonNullable<RunEvent['report']>) => {
                const chart = getChart();
                if (!chart?.drawings.supported) {
                    appendLog('当前图表不支持绘图标记，无法显示开平仓点。');
                    return;
                }
                clearTradeMarkers();
                report.fills.forEach((fill, index) => {
                    const label = fill.entry
                        ? (fill.side === 'buy' ? '开多' : '开空')
                        : (fill.side === 'sell' ? '平多' : '平空');
                    const color = fill.entry
                        ? (fill.side === 'buy' ? '#26a69a' : '#ef5350')
                        : '#f0b90b';
                    const drawing = chart.drawings.add(
                        fill.entry
                            ? (fill.side === 'buy' ? 'arrowmarkup' : 'arrowmarkdown')
                            : 'flagmark',
                        {
                            anchors: [{ time: fill.barOpenTime ?? fill.time, price: fill.price }],
                            style: { lineColor: color, lineWidth: 1, lineStyle: 'solid' },
                            ...(fill.entry ? {} : { props: { glyph: '⚑', size: 'small' } }),
                            text: {
                                value: `${label} ${fill.qty} @ ${fill.price.toFixed(2)}`,
                                size: 'small',
                                hAlign: 'center',
                                vAlign: fill.entry && fill.side === 'buy' ? 'bottom' : 'top',
                                color,
                                bold: true,
                            },
                            zIndex: 1_000_000 + index,
                        },
                    );
                    if (drawing) {
                        aiMarkerIds.push(drawing.id);
                        chart.drawings.bringToFront(drawing.id);
                    }
                });
            };
            const stopReplay = () => {
                const chart = getChart();
                try {
                    if (chart?.replay.state.active) chart.replay.stop();
                } catch {
                    /* chart already destroyed */
                }
                replayPlan = null;
            };

            const query = () => {
                const params = new URLSearchParams({
                    symbol: currentSymbol,
                    date: date.value,
                    timeframe: currentTimeframe,
                });
                return params;
            };

            const checkPlan = async () => {
                clear();
                setBusy(true);
                try {
                    const data = await api.get(`/backtest/session?${query()}`);
                    const plan = data.plan;
                    setContext(`<b>${escapeHtml(currentSymbol)}</b> · ${escapeHtml(data.date)} · ${escapeHtml(data.timeframe)} · ${etClock(plan.open)}–${etClock(plan.close)} ET · 决策 ${plan.decisionTimes.length} 次 · bar ${data.sessionBars} 根${data.isEarlyClose ? ' · 半日市' : ''}`);
                    setSystemPrompt(data.systemPrompt);
                    setStatus(`强平 ${etClock(plan.flattenAt)} ET · 预热 ${data.warmupBars} 根`);
                } catch (error) {
                    appendLog(`<span class="vbt-down">${escapeHtml(error instanceof Error ? error.message : String(error))}</span>`);
                } finally {
                    setBusy(false);
                }
            };

            const renderReport = (report: NonNullable<RunEvent['report']>) => {
                const m = report.metrics;
                const pnlClass = m.netPnl >= 0 ? 'vbt-up' : 'vbt-down';
                summary.innerHTML = `<div class="vbt-metrics">
                  <div class="vbt-metric"><span>净收益</span><b class="${pnlClass}">${money(m.netPnl)}</b></div>
                  <div class="vbt-metric"><span>收益率</span><b class="${pnlClass}">${pct(m.returnPct)}</b></div>
                  <div class="vbt-metric"><span>最大回撤</span><b>${pct(-m.maxDrawdownPct)}</b></div>
                  <div class="vbt-metric"><span>胜率 / 交易</span><b>${m.tradeCount ? `${m.winRate.toFixed(0)}% / ${m.tradeCount}` : '—'}</b></div>
                  <div class="vbt-metric"><span>开仓</span><b>${m.entriesUsed} / ${m.entryLimit}</b></div>
                  <div class="vbt-metric"><span>费用</span><b>${money(m.feesPaid)}</b></div>
                </div>`;
                renderEquity(equity, report.equityCurve);
                if (report.closedTrades.length === 0) {
                    trades.innerHTML = '<div class="vbt-empty">当日没有成交。</div>';
                    return;
                }
                const rows = report.closedTrades.map((trade) => {
                    const pnl = Number(trade.pnl || 0);
                    return `<tr>
                      <td>${trade.side === 'short' ? '空' : '多'} ${trade.qty}</td>
                      <td>${etClock(Number(trade.entryTime))} → ${etClock(Number(trade.exitTime))}</td>
                      <td>${money(Number(trade.entryPrice))} → ${money(Number(trade.exitPrice))}</td>
                      <td class="${pnl >= 0 ? 'vbt-up' : 'vbt-down'}">${money(pnl)}</td>
                    </tr>`;
                }).join('');
                trades.innerHTML = `<table class="vbt-table">
                  <thead><tr><th>方向</th><th>时间</th><th>价格</th><th>盈亏</th></tr></thead>
                  <tbody>${rows}</tbody>
                </table>`;
            };

            const handleFrame = (payload: string, onDone: (report: NonNullable<RunEvent['report']>, cancelled: boolean) => void) => {
                let event: RunEvent;
                try {
                    event = JSON.parse(payload);
                } catch {
                    return;
                }
                if (event.type === 'run' && event.runId) {
                    currentRunId = event.runId;
                    pauseButton.disabled = false;
                    return;
                }
                if (event.type === 'control' && event.action) {
                    if (event.action === 'cancel') {
                        setStatus('正在取消回测…', true);
                        return;
                    }
                    if (event.action === 'stop') {
                        stopButton.disabled = true;
                        stopButton.textContent = '停止中…';
                        pauseButton.disabled = true;
                        setStatus('正在停止，等待当前决策结束…', true);
                        return;
                    }
                    paused = event.action === 'pause';
                    pauseButton.textContent = paused ? '继续' : '暂停';
                    setStatus(paused ? '已暂停；当前决策完成后停止推进。' : '回测中…', !paused);
                    return;
                }
                if (event.type === 'session') {
                    if (event.phase === 'loading' && event.plan) {
                        setStatus('加载行情…', true);
                    } else if (event.phase === 'ready' && event.plan) {
                        const plan = event.plan;
                        setContext(`<b>${escapeHtml(currentSymbol)}</b> · ${escapeHtml(date.value)} · ${escapeHtml(currentTimeframe)} · ${etClock(plan.open)}–${etClock(plan.close)} ET · 决策 ${plan.decisionTimes.length} 次 · bar ${event.bars ?? 0} 根${plan.isEarlyClose ? ' · 半日市' : ''}`);
                        setSystemPrompt(event.systemPrompt);
                        setStatus('回测中…', true);
                    }
                    return;
                }
                if (event.type === 'decision') {
                    revealDecisionBar();
                    beginTurn(event);
                    return;
                }
                if (event.type === 'agent' && event.event) {
                    const agentEvent = event.event as Record<string, unknown>;
                    if (agentEvent.type === 'reasoning' && agentEvent.delta) {
                        appendReasoning(String(agentEvent.delta));
                    } else if (agentEvent.type === 'content' && agentEvent.delta) {
                        appendContent(String(agentEvent.delta));
                    } else if (agentEvent.type === 'assistant' && agentEvent.content) {
                        appendAssistant(String(agentEvent.content));
                    } else if (agentEvent.type === 'tool_call') {
                        appendToolCall(String(agentEvent.name), agentEvent.args);
                    } else if (agentEvent.type === 'tool_result') {
                        appendToolResult(
                            String(agentEvent.name),
                            agentEvent.result as { ok?: boolean; error?: { message?: string } } | undefined,
                        );
                    } else if (agentEvent.type === 'finish') {
                        appendFinish(String(agentEvent.summary ?? ''));
                    } else if (agentEvent.type === 'error') {
                        appendTurnError(String(agentEvent.message ?? 'agent error'));
                    }
                    return;
                }
                if (event.type === 'done' && event.report) {
                    if (!event.report.stopped && !event.cancelled) revealSessionEnd();
                    addTradeMarkers(event.report);
                    onDone(event.report, event.cancelled === true);
                    return;
                }
                if (event.type === 'cancelled') {
                    if (cancellationTimer) clearTimeout(cancellationTimer);
                    cancellationTimer = null;
                    stopReplay();
                    clearTradeMarkers();
                    setBusy(false);
                    cancelButton.hidden = true;
                    setStatus('已取消回测，图表已恢复实时模式。');
                    return;
                }
                if (event.type === 'error') {
                    stopReplay();
                    clearTradeMarkers();
                    appendLog(`<span class="vbt-down">${escapeHtml(event.message ?? '回测失败')}</span>`);
                }
            };

            const run = async () => {
                clear();
                clearTradeMarkers();
                setBusy(true);
                abort = new AbortController();
                let done = false;
                try {
                    const sessionData = await api.get(`/backtest/session?${query()}`, { signal: abort.signal });
                    const plan = sessionData.plan;
                    const chart = getChart();
                    if (!chart) throw new Error('没有可回放的图表');
                    setStatus('准备图表回放…', true);
                    await chart.replay.start({ from: plan.open - 1 });
                    if (!chart.replay.state.active) {
                        throw new Error('图表没有可用于回放的历史数据，请先加载该交易日的历史');
                    }
                    replayPlan = { open: plan.open, close: plan.close };
                    setStatus(`等待 ${etClock(plan.open)} 首根 K 线收盘…`, true);

                    const res = await fetch(`${API_BASE}/backtest/run`, {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({
                            symbol: currentSymbol,
                            date: date.value,
                            timeframe: currentTimeframe,
                            positionSizePct: Number(size.value),
                            maxEntriesPerDay: Number(entries.value),
                            initialCapital: Number(capital.value),
                            allowShort: true,
                            allowAddOn: false,
                        }),
                        signal: abort.signal,
                    });
                    if (!res.ok) {
                        let message = `HTTP ${res.status}`;
                        try {
                            const data = await res.json();
                            if (data?.message) message = data.message;
                            else if (data?.error) message = data.error;
                        } catch {
                            /* not JSON */
                        }
                        throw new Error(message);
                    }
                    const type = res.headers.get('content-type') || '';
                    if (!type.includes('text/event-stream') || !res.body) throw new Error('服务端没有返回事件流');
                    const reader = res.body.getReader();
                    const decoder = new TextDecoder();
                    let buffer = '';
                    for (;;) {
                        const { value, done: streamDone } = await reader.read();
                        if (streamDone) break;
                        buffer += decoder.decode(value, { stream: true });
                        let cut;
                        while ((cut = buffer.indexOf('\n\n')) >= 0) {
                            const frame = buffer.slice(0, cut).trim();
                            buffer = buffer.slice(cut + 2);
                            const line = frame.split('\n').find((item) => item.startsWith('data:'));
                            if (!line) continue;
                            const payload = line.slice(5).trim();
                            if (!payload) continue;
                            handleFrame(payload, (report, cancelled) => {
                                done = true;
                                if (cancelled) appendFinish('回测已取消');
                                else if (report.stopped) appendFinish('回测已停止');
                                renderReport(report);
                                if (cancelled) {
                                    setStatus(`回测已取消 · 部分结果 · 成交 ${report.fills.length} 笔`);
                                } else if (report.stopped) {
                                    setStatus(`回测已停止 · ${report.session.date} · 成交 ${report.fills.length} 笔`);
                                } else {
                                    setStatus(`回测完成 · ${report.session.date} · 成交 ${report.fills.length} 笔`);
                                }
                            });
                        }
                    }
                    if (!done) appendLog('事件流已结束，但没有收到回测报告。');
                } catch (error) {
                    if ((error as Error).name !== 'AbortError') {
                        appendLog(`<span class="vbt-down">${escapeHtml(error instanceof Error ? error.message : String(error))}</span>`);
                    }
                } finally {
                    if (cancellationTimer) clearTimeout(cancellationTimer);
                    cancellationTimer = null;
                    if (!done) stopReplay();
                    abort = null;
                    setBusy(false);
                }
            };

            runButton.addEventListener('click', () => void run());
            planButton.addEventListener('click', () => void checkPlan());
            pauseButton.addEventListener('click', async () => {
                if (!currentRunId) return;
                const action = paused ? 'resume' : 'pause';
                pauseButton.disabled = true;
                try {
                    const data = await api.post('/backtest/control', { runId: currentRunId, action });
                    paused = Boolean(data.paused);
                    pauseButton.textContent = paused ? '继续' : '暂停';
                    setStatus(paused ? '已暂停' : '回测中…', !paused);
                } catch (error) {
                    appendLog(`<span class="vbt-down">${escapeHtml(error instanceof Error ? error.message : String(error))}</span>`);
                } finally {
                    pauseButton.disabled = false;
                }
            });
            cancelButton.addEventListener('click', () => {
                const runId = currentRunId;
                if (!runId) {
                    abort?.abort();
                    abort = null;
                    stopReplay();
                    clearTradeMarkers();
                    setBusy(false);
                    cancelButton.hidden = true;
                    setStatus('已退出回测，图表已恢复实时模式。');
                    return;
                }
                // Stop the run immediately but keep the SSE open for the partial
                // report, so the result panel survives the cancellation.
                setStatus('正在取消回测…', true);
                cancelButton.disabled = true;
                void api.post('/backtest/control', { runId, action: 'cancel' }).catch(() => {
                    /* the stream settles on its own */
                });
                cancellationTimer = setTimeout(() => {
                    if (!busy) return;
                    abort?.abort();
                    abort = null;
                    stopReplay();
                    clearTradeMarkers();
                    setBusy(false);
                    cancelButton.hidden = true;
                    setStatus('已取消回测，图表已恢复实时模式。');
                }, 20_000);
            });
            stopButton.addEventListener('click', async () => {
                if (!currentRunId) {
                    abort?.abort();
                    stopReplay();
                    clearTradeMarkers();
                    setStatus('已停止。');
                    return;
                }
                stopButton.disabled = true;
                pauseButton.disabled = true;
                stopButton.textContent = '停止中…';
                try {
                    await api.post('/backtest/control', { runId: currentRunId, action: 'stop' });
                } catch (error) {
                    appendLog(`<span class="vbt-down">${escapeHtml(error instanceof Error ? error.message : String(error))}</span>`);
                }
            });
            copyButton.addEventListener('click', async () => {
                const text = log.textContent ?? '';
                try {
                    await navigator.clipboard.writeText(text);
                    ctx.toast('日志已复制', 'success');
                } catch {
                    const area = document.createElement('textarea');
                    area.value = text;
                    document.body.appendChild(area);
                    area.select();
                    document.execCommand('copy');
                    area.remove();
                    ctx.toast('日志已复制', 'success');
                }
            });
            try {
                bindChart(ctx.chart as ChartLike);
            } catch {
                syncFromChart();
            }

            return {
                onChart(chart) {
                    bindChart(chart as ChartLike);
                },
                destroy() {
                    abort?.abort();
                    stopReplay();
                    clearTradeMarkers();
                    offMarket?.();
                    removeStyle();
                },
            };
        },
    });
}
