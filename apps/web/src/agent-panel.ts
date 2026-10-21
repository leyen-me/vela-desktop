import { API_BASE, api } from './api.ts';
import { TF_MAP } from './provider.ts';
import { TIMEZONE } from './storage.ts';
import type { Bar, VelaChart } from './types.ts';

// The agent column's UI. The backend is intentionally a thin contract so the runtime
// can be swapped later: POST /api/v1/agent { symbol, timeframe, messages } and answer
// with JSON { reply } or an SSE stream of { delta } / { text } frames.
export function mountAgentPanel(ctx: any, body: HTMLElement) {
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
.vagent-tools { display: flex; flex-direction: column; gap: 3px; margin-bottom: 6px; }
.vagent-tool { display: flex; align-items: center; gap: 5px; font-size: 11px;
  color: var(--vela-fg-muted, #8a8f9c); }
.vagent-tool[data-ok='0'] { color: #e57373; }
.vagent-tool-name { color: var(--vela-fg, #d1d4dc); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
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
  systemSummary.textContent = '图表上下文 · 加载中…';
  const systemBody = document.createElement('div');
  systemBody.className = 'vagent-system-body';
  systemBody.textContent = '正在读取当前标的与当日 K 线…';
  systemEl.append(systemSummary, systemBody);
  root.prepend(systemEl);

  const effortLabel = (effort?: string) => ({ low: '低', high: '高', max: '最高' } as Record<string, string>)[effort ?? ''] ?? effort ?? '';
  const setSystem = (content: string, meta: any = {}) => {
    const imageState = meta.vision ? ' · 截图已附' : meta.images ? ' · 截图未附' : '';
    const effort = effortLabel(meta.effort);
    systemSummary.textContent = `图表上下文 · ${(meta.symbol ?? '').split(':').pop()} ${meta.timeframe ?? ''} · ${meta.model ?? ''}${effort ? ` · 思考强度${effort}` : ''}${imageState}`;
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
      const data = await api.get<{ configured: boolean }>('/agent/status');
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
      const data = await api.get<{ content: string; meta: Record<string, unknown> }>(`/agent/system?${params}`);
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
        const toolList = document.createElement('div');
        toolList.className = 'vagent-tools';
        const answerEl = document.createElement('div');
        answerEl.className = 'vagent-answer';
        answerEl.dataset.streaming = '1';
        node.append(details, toolList, answerEl);
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
          if (parsed.type === 'tool') {
            const line = document.createElement('div');
            line.className = 'vagent-tool';
            line.dataset.ok = parsed.ok === false ? '0' : '1';
            const icon = document.createElement('span');
            icon.textContent = parsed.ok === false ? '✗' : '✓';
            const name = document.createElement('span');
            name.className = 'vagent-tool-name';
            name.textContent = String(parsed.name ?? 'tool').replace(/^mcp__[^_]+__/, '');
            line.append(icon, name);
            if (typeof parsed.message === 'string' && parsed.message) line.title = parsed.message.slice(0, 1000);
            toolList.appendChild(line);
            msgsEl.scrollTop = msgsEl.scrollHeight;
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

