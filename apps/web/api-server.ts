import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { ServerResponse } from 'node:http';
import {
  AGENT_BODY_LIMIT,
  BACKTEST_BODY_LIMIT,
  CONTROL_BODY_LIMIT,
  DEFAULT_BAR_COUNT,
  DEFAULT_HOST,
  DEFAULT_PORT,
  MAX_AGENT_IMAGES,
  MAX_BAR_LIMIT,
} from './server/config.ts';
import { AppError, ERROR_CODES, badRequest, methodNotAllowed, notFound } from './server/errors.ts';
import { logger } from './server/logger.ts';
import { docsHtml, openapi } from './server/openapi.ts';
import { paginate, readJsonBody, send, stripApiPrefix } from './server/http.ts';
import { oneOf, parsePagination, parseInteger, requireString, resolveWithin, usSymbol } from './server/validate.ts';
import { buildAgentPrompt } from './server/agent.ts';
import { agentStatus, shutdownDsh, streamAnalysis } from './server/dsh/agent.ts';
import { DshBacktestAgent } from './server/dsh/backtest-agent.ts';
import { DSH_MODEL, DSH_REASONING_EFFORT } from './server/dsh/config.ts';
import {
  TF,
  agentTfLabel,
  fetchWindow,
  setCandleListener,
  subscribeCandlesticks,
  ttlOf,
  unsubscribeCandlesticks,
  usSymbols,
} from './server/longbridge.ts';
import {
  cacheCount,
  cacheCoveredFrom,
  cacheFetchedAt,
  cacheGet,
  cacheGetWindow,
  cachePut,
  closeDb,
} from './server/db.ts';
import {
  FAMILY_LABELS,
  invalidateIndicatorIndex,
  listIndicators,
  loadCustom,
  PINE_DIR,
  saveCustom,
  slugId,
} from './server/indicators.ts';
import {
  type Timeframe,
  buildTradingDayPlan,
  inferSessionCloseFromBars,
  sessionDateInZone,
  timeframeMs,
  runBacktest,
  type DecisionInput,
} from '@vela/trading-core';

type StreamEntry = { symbol: string; tf: string; period: unknown; clients: Set<ServerResponse>; subscribed: boolean };
type RunState = { runId: string; paused: boolean; stopped: boolean };
type BacktestRun = {
  pause: () => void;
  resume: () => void;
  stop: () => void;
  state: () => RunState;
  controlToken: string;
  agent: DshBacktestAgent;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  /* .env is optional */
}
const DIST = path.join(__dirname, 'dist');

const REQUIRED_ENV = ['LONGPORT_APP_KEY', 'LONGPORT_APP_SECRET', 'LONGPORT_ACCESS_TOKEN'] as const;
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missingEnv.length > 0) {
  logger.warn('Longbridge credentials missing; market data will be unavailable', { missing: missingEnv });
}

// --- Longbridge: force the international gateway ---
process.env.LONGPORT_HTTP_URL ||= 'https://openapi.longportapp.com';
process.env.LONGPORT_QUOTE_WS_URL ||= 'wss://openapi-quote.longportapp.com/v2';
process.env.LONGPORT_TRADE_WS_URL ||= 'wss://openapi-trade.longportapp.com/v2';
process.env.LONGPORT_PUSH_CANDLESTICK_MODE ||= 'realtime';

// Intraday analysis agent (DeepSeek V4.1 Flash, OpenAI-compatible API). The key comes
// from the environment first, then from a local, git-ignored data/agent.json:
//   { "apiKey": "...", "baseURL": "...", "model": "deepseek-flash", "reasoningEffort": "low" }
// V4.1 Flash (`deepseek-flash`) is natively multimodal, so screenshots go straight into
// the user message's `content` parts; no separate vision endpoint is needed.
// The SDK pushes through one socket owned by the QuoteContext, so subscriptions are
// reference-counted per (symbol, timeframe) and fanned out to every connected client.
const streams = new Map<string, StreamEntry>();
const backtestRuns = new Map<string, BacktestRun>();

function sendFrame(client: ServerResponse, payload: string): void {
  if (client.destroyed || client.writableEnded) return;
  try {
    client.write(payload);
  } catch {
    /* the client disconnected between the check and the write */
  }
}

setCandleListener(({ symbol, tf, bar, confirmed }) => {
  const entry = streams.get(`${symbol}|${tf}`);
  if (!entry) return;
  const payload = `data: ${JSON.stringify({ symbol, tf, confirmed, bar })}\n\n`;
  for (const client of entry.clients) sendFrame(client, payload);
  // Only the closed bar is worth persisting; the forming candle is pushed many times
  // per second and the history endpoint answers it anyway.
  if (confirmed) cachePut(symbol, tf, [bar], {});
});

async function subscribeStream(entry: StreamEntry): Promise<void> {
  if (entry.subscribed) return;
  await subscribeCandlesticks(entry.symbol, entry.period);
  entry.subscribed = true;
}

// ---------------- helpers ----------------
// Fallback catalogue if the live Longbridge list can't be fetched. US-only: this app
// targets Longbridge US equities.
// ---------------- server ----------------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url ?? '/', 'http://localhost');
  const pathname = stripApiPrefix(u.pathname);
  const startedAt = Date.now();
  res.on('finish', () => {
    logger.info('http', { method: req.method, path: u.pathname, status: res.statusCode, ms: Date.now() - startedAt });
  });
  try {
    if (pathname === '/api/openapi.json') {
      return send(res, 200, JSON.stringify(openapi));
    }

    if (pathname === '/api/docs') {
      return send(res, 200, docsHtml, 'text/html; charset=utf-8');
    }

    if (pathname === '/api/health') {
      return send(res, 200, JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    }

    if (pathname === '/api/stream') {
      const symbol = usSymbol(u.searchParams.get('symbol'));
      const tf = oneOf(u.searchParams.get('tf'), Object.keys(TF), 'tf');
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
      res.on('error', () => {}); // a client dropping mid-frame must not take the service down
      sendFrame(res, ': connected\n\n');
      const key = `${symbol}|${tf}`;
      let entry = streams.get(key);
      if (!entry) {
        entry = { symbol, tf, period: TF[tf], clients: new Set(), subscribed: false };
        streams.set(key, entry);
      }
      entry.clients.add(res);
      const heartbeat = setInterval(() => sendFrame(res, ': ping\n\n'), 15_000);
      subscribeStream(entry).catch((e) => {
        logger.warn(`[push] subscribe failed ${symbol} ${tf}:`, e.message);
        sendFrame(res, `event: stream-error\ndata: ${JSON.stringify({ message: e.message })}\n\n`);
      });
      req.on('close', () => {
        clearInterval(heartbeat);
        entry.clients.delete(res);
        if (entry.clients.size > 0) return;
        streams.delete(key);
        if (!entry.subscribed) return;
        void (async () => {
          try {
            await unsubscribeCandlesticks(entry.symbol, entry.period);
          } catch {
            /* the socket is already gone */
          }
        })();
      });
      return;
    }

    if (pathname === '/api/agent/status') {
      return send(res, 200, JSON.stringify(agentStatus()));
    }

    // The chart context sent with every turn, so the panel can show what the
    // harness sees before the first candle closes.
    if (pathname === '/api/agent/system') {
      const symbol = u.searchParams.get('symbol') || '';
      const timeframe = u.searchParams.get('timeframe') || '';
      const content = await buildAgentPrompt({ symbol, timeframe, context: {} }, false);
      return send(res, 200, JSON.stringify({
        content,
        meta: {
          symbol,
          timeframe: agentTfLabel(timeframe),
          model: DSH_MODEL,
          effort: DSH_REASONING_EFFORT,
          vision: false,
          images: 0,
        },
      }));
    }

    // Intraday analysis agent. The DeepSeek key never reaches the renderer: the
    // server drives a dsh SDK runtime and relays its session events as SSE.
    if (pathname === '/api/agent') {
      if (req.method !== 'POST') return send(res, 405, JSON.stringify({ error: 'method not allowed' }));
      const status = agentStatus();
      if (!status.enabled) {
        return send(res, 503, JSON.stringify({ error: 'DSH_ENABLED=false，AI 功能已停用' }));
      }
      if (!status.configured) {
        return send(res, 503, JSON.stringify({
          error: '未检测到 DEEPSEEK_API_KEY，请设置环境变量后重启应用（或在 data/agent.json 中配置 apiKey）',
        }));
      }
      const body = await readJsonBody(req, AGENT_BODY_LIMIT);
      const images = Array.isArray(body.images) ? body.images.filter((img) => img && img.data).slice(0, MAX_AGENT_IMAGES) : [];
      body.images = images;
      const system = await buildAgentPrompt(body, images.length > 0);
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
      res.on('error', () => {});
      sendFrame(res, `data: ${JSON.stringify({
        type: 'system',
        content: system,
        meta: {
          symbol: body.symbol,
          timeframe: agentTfLabel(body.timeframe),
          model: status.model,
          effort: status.effort,
          vision: images.length > 0,
          images: images.length,
        },
      })}\n\n`);
      try {
        await streamAnalysis(body, (event) => {
          sendFrame(res, `data: ${JSON.stringify(event)}\n\n`);
        });
      } catch (error) {
        logger.warn('[agent] dsh turn failed', { message: (error as Error).message });
        sendFrame(res, `data: ${JSON.stringify({ type: 'error', message: (error as Error).message })}\n\n`);
      } finally {
        res.end();
      }
      return;
    }

    // Private back-channel used by the per-run MCP bridge. It never leaves the
    // loopback interface and every call carries the run's one-time token.
    const internalTool = /^\/api\/internal\/backtest\/([A-Za-z0-9-]+)\/tool$/.exec(pathname);
    if (internalTool) {
      if (req.method !== 'POST') throw methodNotAllowed();
      const run = backtestRuns.get(internalTool[1]);
      if (!run) throw notFound('run not found or already finished');
      if (req.headers['x-backtest-token'] !== run.controlToken) {
        throw new AppError('invalid backtest token', { status: ERROR_CODES.UNAUTHORIZED });
      }
      const body = await readJsonBody(req, CONTROL_BODY_LIMIT);
      const name = requireString(body.name, 'name', { maxLength: 64 });
      const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : {};
      return send(res, 200, JSON.stringify({ result: run.agent.executeTool(name, args) }));
    }

    if (pathname === '/api/backtest/session') {
      try {
        const symbol = usSymbol(u.searchParams.get('symbol'));
        const date = requireString(u.searchParams.get('date'), 'date', { maxLength: 10 });
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('date must be YYYY-MM-DD');
        const timeframe = oneOf(u.searchParams.get('timeframe') || '5m', Object.keys(TF), 'timeframe') as Timeframe;
        const tfMs = timeframeMs(timeframe);
        const base = buildTradingDayPlan({ date, timeframe });
        if (!base.isTradingDay) throw badRequest(`${date} is not a US trading day`);
        const today = sessionDateInZone(Date.now(), 'America/New_York');
        if (date > today) throw badRequest('Backtest date is in the future');
        if (date === today && Date.now() < base.close) throw badRequest("Today's session is not finished yet");
        const from = base.open - 7 * 86_400_000;
        const { bars, hitGenesis } = await fetchWindow(symbol, timeframe, from, base.close, 10_000);
        const coreBars = bars.map((bar) => ({
          symbol,
          timeframe,
          openTime: bar.time,
          closeTime: bar.time + tfMs,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume ?? 0,
        }));
        const earlyClose = inferSessionCloseFromBars(coreBars, base);
        const plan = earlyClose ? buildTradingDayPlan({ date, timeframe, close: earlyClose }) : base;
        const sessionBars = coreBars.filter(
          (bar) => bar.closeTime > plan.open && bar.closeTime <= plan.close,
        );
        return send(res, 200, JSON.stringify({
          symbol,
          date,
          timeframe,
          plan,
          isEarlyClose: plan.isEarlyClose,
          sessionBars: sessionBars.length,
          warmupBars: coreBars.length - sessionBars.length,
          hitGenesis,
        }));
      } catch (e) {
        return send(res, 400, JSON.stringify({ error: (e as Error).message }));
      }
    }

    if (pathname === '/api/backtest/control') {
      if (req.method !== 'POST') throw methodNotAllowed();
      const body = await readJsonBody(req, CONTROL_BODY_LIMIT);
      const runId = requireString(body.runId, 'runId', { maxLength: 64 });
      const run = backtestRuns.get(runId);
      if (!run) throw notFound('run not found or already finished');
      const action = oneOf(body.action, ['pause', 'resume', 'stop'], 'action');
      if (action === 'pause') run.pause();
      else if (action === 'resume') run.resume();
      else run.stop();
      return send(res, 200, JSON.stringify({ ok: true, ...run.state() }));
    }

    if (pathname === '/api/backtest/run') {
      if (req.method !== 'POST') throw methodNotAllowed();
      const status = agentStatus();
      if (!status.enabled) {
        return send(res, 503, JSON.stringify({ error: 'DSH_ENABLED=false，AI 回测已停用' }));
      }
      if (!status.configured) {
        return send(res, 503, JSON.stringify({
          error: '未检测到 DEEPSEEK_API_KEY，无法运行 AI 回测',
        }));
      }
      const body = await readJsonBody(req, BACKTEST_BODY_LIMIT);
      const symbol = usSymbol(body.symbol);
      const date = requireString(body.date, 'date', { maxLength: 10 });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('date must be YYYY-MM-DD');
      const timeframe = oneOf(body.timeframe || '5m', Object.keys(TF), 'timeframe') as Timeframe;
      const positionSizePct = parseInteger(body.positionSizePct, 'positionSizePct', { min: 1, max: 100, fallback: 80 });
      const maxEntriesPerDay = parseInteger(body.maxEntriesPerDay, 'maxEntriesPerDay', { min: 1, max: 50, fallback: 2 });
      const allowShort = body.allowShort !== false;
      const allowAddOn = body.allowAddOn === true;
      const initialCapital = parseInteger(body.initialCapital, 'initialCapital', { min: 1, max: 1_000_000_000, fallback: 100_000 });
      const slippageBps = parseInteger(body.slippageBps, 'slippageBps', { min: 0, max: 1000, fallback: 2 });
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
      const emit = (event: unknown) => sendFrame(res, `data: ${JSON.stringify(event)}\n\n`);
      const abort = new AbortController();
      const stopAbort = new AbortController();
      res.on('error', () => {});
      res.on('close', () => abort.abort());
      const runId = randomUUID();
      const pauseState: { paused: boolean; waiters: Array<() => void> } = { paused: false, waiters: [] };
      const waitIfPaused = (): Promise<void> => {
        if (!pauseState.paused) return Promise.resolve();
        return new Promise<void>((resolve) => {
          const release = () => {
            abort.signal.removeEventListener('abort', release);
            stopAbort.signal.removeEventListener('abort', release);
            resolve();
          };
          abort.signal.addEventListener('abort', release, { once: true });
          stopAbort.signal.addEventListener('abort', release, { once: true });
          pauseState.waiters.push(release);
        });
      };
      const controlToken = randomUUID();
      const agentRuntime = new DshBacktestAgent({
        runId,
        controlToken,
        controlUrl: `http://127.0.0.1:${PORT}/api/v1/internal/backtest`,
        signal: AbortSignal.any([abort.signal, stopAbort.signal]),
        onEvent: (event) => {
          if (event.type === 'error') logger.warn('[backtest] agent error:', event.message);
          else if (event.type === 'tool_result' && !event.result.ok) {
            logger.warn('[backtest] tool rejected:', event.name, event.result.error?.code, event.result.error?.message);
          }
          emit({ type: 'agent', event });
        },
      });
      const runControl: BacktestRun = {
        controlToken,
        agent: agentRuntime,
        pause() {
          if (pauseState.paused) return;
          pauseState.paused = true;
          emit({ type: 'control', action: 'pause' });
        },
        resume() {
          if (!pauseState.paused) return;
          pauseState.paused = false;
          const waiters = pauseState.waiters.splice(0);
          for (const release of waiters) release();
          emit({ type: 'control', action: 'resume' });
        },
        stop() {
          if (stopAbort.signal.aborted) return;
          stopAbort.abort();
          const waiters = pauseState.waiters.splice(0);
          for (const release of waiters) release();
          emit({ type: 'control', action: 'stop' });
        },
        state() {
          return { runId, paused: pauseState.paused, stopped: stopAbort.signal.aborted };
        },
      };
      backtestRuns.set(runId, runControl);
      logger.info(`[backtest] run ${runId} ${symbol} ${date} ${timeframe}`);
      emit({ type: 'run', runId });
      try {
        const tfMs = timeframeMs(timeframe);
        const base = buildTradingDayPlan({ date, timeframe });
        if (!base.isTradingDay) throw badRequest(`${date} is not a US trading day`);
        const today = sessionDateInZone(Date.now(), 'America/New_York');
        if (date > today) throw badRequest('Backtest date is in the future');
        if (date === today && Date.now() < base.close) throw badRequest("Today's session is not finished yet");
        emit({ type: 'session', phase: 'loading', plan: base });
        const from = base.open - 7 * 86_400_000;
        const { bars } = await fetchWindow(symbol, timeframe, from, base.close, 10_000);
        const coreBars = bars.map((bar) => ({
          symbol,
          timeframe,
          openTime: bar.time,
          closeTime: bar.time + tfMs,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume ?? 0,
        }));
        const earlyClose = inferSessionCloseFromBars(coreBars, base);
        const session = earlyClose ? buildTradingDayPlan({ date, timeframe, close: earlyClose }) : base;
        emit({ type: 'session', phase: 'ready', plan: session, bars: coreBars.length });
        const inner = runControl.agent;
        const wrapped = {
          async decide(input: DecisionInput) {
            emit({ type: 'decision', asOf: input.asOf, entryQuota: input.entryQuota, position: input.position });
            return inner.decide(input);
          },
        };
        const report = await runBacktest({
          config: {
            symbol,
            date,
            timeframe,
            initialCapital,
            positionSizePct,
            maxEntriesPerDay,
            allowShort,
            allowAddOn,
            slippageBps,
          },
          session: earlyClose ? { close: earlyClose } : {},
          bars: coreBars,
          agent: wrapped,
          signal: abort.signal,
          stopSignal: stopAbort.signal,
          waitIfPaused,
        });
        logger.info(`[backtest] done ${runId}${report.stopped ? ' (stopped)' : ''} entries=${report.metrics.entriesUsed} pnl=${report.metrics.netPnl.toFixed(2)}`);
        emit({
          type: 'done',
          report: {
            session: report.session,
            metrics: report.metrics,
            orders: report.orders,
            fills: report.fills,
            closedTrades: report.closedTrades,
            equityCurve: report.equityCurve,
            blockedOrders: report.blockedOrders,
            decisions: report.decisions.length,
            finalAccount: report.finalAccount,
            stopped: report.stopped,
            ...(report.stoppedAt != null ? { stoppedAt: report.stoppedAt } : {}),
          },
        });
        res.end();
      } catch (e) {
        if (!abort.signal.aborted) {
          logger.warn(`[backtest] failed ${runId}:`, (e as Error).message);
          emit({ type: 'error', message: (e as Error).message });
        }
        res.end();
      } finally {
        await runControl.agent.close();
        backtestRuns.delete(runId);
      }
      return;
    }

    if (pathname === '/api/bars') {
      const symbol = usSymbol(u.searchParams.get('symbol') || 'AAPL.US');
      const tf = oneOf(u.searchParams.get('tf') || '1d', Object.keys(TF), 'tf');
      const from = u.searchParams.has('from')
        ? parseInteger(u.searchParams.get('from'), 'from', { min: 0 })
        : null;
      const to = u.searchParams.has('to')
        ? parseInteger(u.searchParams.get('to'), 'to', { min: 0 })
        : null;
      const limit = parseInteger(
        u.searchParams.get('count') || u.searchParams.get('limit'),
        'count',
        { min: 1, max: MAX_BAR_LIMIT, fallback: DEFAULT_BAR_COUNT },
      );
      const windowed = from != null || to != null;

      // ---- bounded window (Vela's backfill / request.security range) ----
      if (windowed) {
        let bars = cacheGetWindow(symbol, tf, from, to, limit);
        const coveredFrom = cacheCoveredFrom(symbol, tf);
        const covered =
          to != null &&
          (bars.length >= limit ||
            coveredFrom === 0 ||
            (coveredFrom != null && from != null && coveredFrom <= from));
        let source = 'cache';
        if (!covered) {
          try {
            const { bars: fetched, hitGenesis } = await fetchWindow(symbol, tf, from, to, limit);
            if (fetched.length || hitGenesis) cachePut(symbol, tf, fetched, { hitGenesis });
            bars = cacheGetWindow(symbol, tf, from, to, limit);
            source = 'longbridge';
          } catch (e) {
            if (bars.length === 0) throw e;
            source = 'cache(stale)';
          }
        }
        return send(res, 200, JSON.stringify({ symbol, tf, source, bars }));
      }

      // ---- latest N (initial load / live polling) ----
      const cachedN = cacheCount(symbol, tf);
      const fresh = Date.now() - cacheFetchedAt(symbol, tf) < ttlOf(tf);
      let source = 'cache';
      if (!(fresh && cachedN >= limit)) {
        try {
          const { bars: fetched, hitGenesis } = await fetchWindow(symbol, tf, null, null, limit);
          if (fetched.length) cachePut(symbol, tf, fetched, { hitGenesis });
          source = 'longbridge';
        } catch (e) {
          if (cachedN === 0) throw e;
          source = 'cache(stale)';
        }
      }
      return send(res, 200, JSON.stringify({ symbol, tf, source, bars: cacheGet(symbol, tf, limit) }));
    }

    if (pathname === '/api/symbols') {
      const pagination = parsePagination(u.searchParams);
      return send(res, 200, JSON.stringify(paginate(await usSymbols(), pagination)));
    }

    if (pathname === '/api/indicators.json') {
      const builtins = listIndicators().map((it) => ({
        name: it.name,
        url: `/api/v1/indicators/raw?file=${encodeURIComponent(it.file)}`,
        language: 'pine',
        enabled: false,
        category: FAMILY_LABELS[it.family] ?? it.family,
      }));
      // User scripts ride the same manifest, under a dedicated, editable category.
      const customs = loadCustom().map((s) => ({
        name: s.name,
        script: s.script,
        language: 'pine',
        enabled: false,
        category: '我的脚本',
        editable: true,
        id: s.id,
      }));
      return send(res, 200, JSON.stringify([...customs, ...builtins]));
    }

    if (pathname === '/api/custom-indicators') {
      if (req.method === 'GET') {
        const pagination = parsePagination(u.searchParams);
        return send(res, 200, JSON.stringify(paginate(loadCustom(), pagination)));
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const name = requireString(body.name, 'name', { maxLength: 80 });
        const script = requireString(body.script, 'script', { maxLength: 200_000 });
        const rows = loadCustom();
        const existing = body.id ? rows.find((r) => r.id === body.id) : null;
        if (existing) {
          existing.name = name;
          existing.script = script;
          existing.updatedAt = Date.now();
        } else {
          rows.push({ id: slugId(name), name, script, createdAt: Date.now() });
        }
        saveCustom(rows);
        return send(res, 200, JSON.stringify(existing ?? rows[rows.length - 1]));
      }
      if (req.method === 'DELETE') {
        const id = requireString(u.searchParams.get('id'), 'id', { maxLength: 80 });
        saveCustom(loadCustom().filter((r) => r.id !== id));
        return send(res, 200, JSON.stringify({ ok: true }));
      }
      throw methodNotAllowed();
    }

    if (pathname === '/api/indicators') {
      const pagination = parsePagination(u.searchParams);
      return send(res, 200, JSON.stringify(paginate(listIndicators(), pagination)));
    }

    // Overwrite a bundled (vault) indicator's source in place — the "edit any indicator"
    // path from the chart legend. Matched by declared name.
    if (pathname === '/api/indicators/source' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const name = requireString(body.name, 'name', { maxLength: 120 });
      const script = requireString(body.script, 'script', { maxLength: 200_000 });
      const item = listIndicators().find((it) => it.name === name);
      if (!item) return send(res, 404, JSON.stringify({ error: 'indicator not found' }));
      const full = resolveWithin(PINE_DIR, item.file);
      fs.writeFileSync(full, script);
      invalidateIndicatorIndex();
      return send(res, 200, JSON.stringify({ ok: true, file: item.file }));
    }

    if (pathname === '/api/indicators/raw') {
      const file = u.searchParams.get('file') || '';
      let full;
      try {
        full = resolveWithin(PINE_DIR, file);
      } catch {
        return send(res, 404, 'not found', 'text/plain');
      }
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return send(res, 404, 'not found', 'text/plain');
      return send(res, 200, fs.readFileSync(full), 'text/plain; charset=utf-8');
    }

    if (u.pathname.startsWith('/api/')) throw notFound();

    if (fs.existsSync(DIST)) {
      const rel = decodeURIComponent(pathname === '/' ? 'index.html' : pathname.slice(1));
      let file = path.join(DIST, rel);
      const relToDist = path.relative(DIST, file);
      if (relToDist.startsWith('..') || path.isAbsolute(relToDist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(DIST, 'index.html');
      }
      const MIME: Record<string, string> = {
        '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
        '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
        '.woff2': 'font/woff2', '.png': 'image/png',
      };
      return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
    }

    throw notFound();
  } catch (e) {
    const status = e instanceof AppError ? e.status : ERROR_CODES.INTERNAL_ERROR;
    const message = e instanceof Error ? e.message : String(e);
    const details = e instanceof AppError ? e.details : null;
    if (status >= ERROR_CODES.INTERNAL_ERROR) logger.error('request failed', e);
    return send(res, status, JSON.stringify({ error: message, details }));
  }
});

const requestedPort = Number(process.env.API_PORT);
const PORT = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : DEFAULT_PORT;
const HOST = process.env.HOST || DEFAULT_HOST;
server.listen(PORT, HOST, () => logger.info(`api on http://${HOST}:${PORT}`));

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[api] ${signal} received, shutting down`);
  const forceExit = setTimeout(() => process.exit(1), 10_000);
  forceExit.unref();
  server.close(() => {
    void (async () => {
      try {
        await shutdownDsh();
      } catch {
        /* harness already reaped */
      }
      try {
        closeDb();
      } catch {
        /* already closed */
      }
      process.exit(0);
    })();
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled rejection', reason);
});
process.on('uncaughtException', (error) => {
  logger.error('uncaught exception', error);
  shutdown('uncaughtException');
});

fetchWindow('AAPL.US', '1d', null, null, 2)
  .then(() => logger.info('longbridge warm-up ok'))
  .catch((e) => logger.warn('longbridge warm-up failed:', e.message));

// Pre-fetch the US symbol universe so the picker's first open is instant.
usSymbols()
  .then((rows) => logger.info(`symbol universe ready: ${rows.length} US symbols`))
  .catch((e) => logger.warn('symbol universe failed:', e.message));
