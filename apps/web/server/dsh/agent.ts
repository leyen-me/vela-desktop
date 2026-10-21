import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DeepSeekHarness, type HarnessSession } from '@deepseek-ai/dsh-sdk-client';
import { logger } from '../logger.ts';
import { buildAgentPrompt, loadAgentConfig } from '../agent.ts';
import {
  assertDshNode,
  DSH_ENABLED,
  DSH_HOME,
  DSH_INIT_TIMEOUT_MS,
  DSH_MODEL,
  DSH_PROVIDER,
  DSH_REASONING_EFFORT,
  DSH_SESSION_IDLE_MS,
  DSH_TURN_TIMEOUT_MS,
  DSH_WORKSPACE,
  ensureDshDirs,
} from './config.ts';
import { removePatch, writePatch, type McpServerPatch } from './patch.ts';
import { mapNotification, type AgentStreamEvent, type MapState } from './events.ts';

type HarnessOptions = NonNullable<ConstructorParameters<typeof DeepSeekHarness>[0]>;

let harness: DeepSeekHarness | null = null;
let patchPath: string | null = null;
const sessions = new Map<string, HarnessSession>();
const queues = new Map<string, Promise<unknown>>();
const activeKeys = new Set<string>();
const lastUsed = new Map<string, number>();
let evictTimer: NodeJS.Timeout | null = null;

function startSessionEviction(): void {
  if (evictTimer) return;
  evictTimer = setInterval(() => {
    const cutoff = Date.now() - DSH_SESSION_IDLE_MS;
    for (const [key, usedAt] of lastUsed) {
      if (usedAt > cutoff || activeKeys.has(key)) continue;
      sessions.delete(key);
      lastUsed.delete(key);
      queues.delete(key);
      logger.info('[dsh] session evicted after idle timeout', { key });
    }
    if (sessions.size === 0 && evictTimer) {
      clearInterval(evictTimer);
      evictTimer = null;
    }
  }, Math.min(60_000, DSH_SESSION_IDLE_MS));
  evictTimer.unref();
}

function mcpServers(): McpServerPatch[] {
  return [
    {
      id: 'mcp-trading',
      serverName: 'trading',
      command: process.execPath,
      args: [fileURLToPath(new URL('../mcp/trading-mcp.ts', import.meta.url))],
      env: {
        VELA_API_BASE: `http://127.0.0.1:${process.env.API_PORT || 5174}/api/v1`,
      },
    },
  ];
}

function getHarness(): DeepSeekHarness {
  if (harness) return harness;
  assertDshNode();
  ensureDshDirs();
  patchPath = writePatch('live.patch.yml', mcpServers());
  const options: HarnessOptions = {
    profile: 'sdk',
    patches: [patchPath],
    dshHome: DSH_HOME,
    cwd: DSH_WORKSPACE,
    processCwd: DSH_WORKSPACE,
    initializeTimeoutMs: DSH_INIT_TIMEOUT_MS,
    requestTimeoutMs: DSH_TURN_TIMEOUT_MS,
    provider: DSH_PROVIDER,
    model: DSH_MODEL,
  };
  options.reasoningEffort = DSH_REASONING_EFFORT as NonNullable<HarnessOptions['reasoningEffort']>;
  harness = new DeepSeekHarness(options);
  return harness;
}

function sessionIdFor(key: string): string {
  return `session-${createHash('sha256').update(`vela-live:${key}`).digest('hex').slice(0, 32)}`;
}

async function getSession(key: string): Promise<HarnessSession> {
  const existing = sessions.get(key);
  if (existing) return existing;
  const runtime = getHarness();
  const id = sessionIdFor(key);
  let session: HarnessSession;
  try {
    session = await runtime.resumeSession(id);
  } catch {
    session = runtime.session(id);
  }
  sessions.set(key, session);
  return session;
}

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  queues.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

export type AnalysisBody = {
  symbol?: unknown;
  timeframe?: unknown;
  context?: unknown;
  images?: unknown;
  messages?: unknown;
};

type InlineImage = { mime?: string; data: string };

function collectImages(body: AnalysisBody): InlineImage[] {
  if (!Array.isArray(body.images)) return [];
  return body.images.filter(
    (image): image is InlineImage =>
      Boolean(image) && typeof image === 'object' && typeof (image as InlineImage).data === 'string',
  );
}

function lastUserText(body: AnalysisBody): string {
  if (!Array.isArray(body.messages)) return '';
  const messages = body.messages.filter(
    (message): message is { role: string; content: string } =>
      Boolean(message) &&
      typeof message === 'object' &&
      typeof (message as { content?: unknown }).content === 'string' &&
      typeof (message as { role?: unknown }).role === 'string',
  );
  const last = [...messages].reverse().find((message) => message.role === 'user');
  return last?.content ?? '';
}

type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

function imageBlock(image: InlineImage) {
  const mime: ImageMime =
    image.mime === 'image/png' || image.mime === 'image/webp' || image.mime === 'image/gif' ? image.mime : 'image/jpeg';
  return { type: 'image' as const, data: image.data, mimeType: mime };
}

export async function streamAnalysis(body: AnalysisBody, emit: (event: AgentStreamEvent) => void): Promise<void> {
  const agent = loadAgentConfig();
  if (!agent.key)
    throw new Error('未检测到 DEEPSEEK_API_KEY，请设置环境变量后重启应用（或在 data/agent.json 中配置 apiKey）');
  const images = collectImages(body);
  const prompt = await buildAgentPrompt(body as Record<string, unknown>, images.length > 0);
  const userText = lastUserText(body);
  const text = userText ? `${prompt}\n\n本轮用户消息：\n${userText}` : prompt;
  const input = images.length > 0 ? [{ type: 'text' as const, text }, ...images.map(imageBlock)] : text;
  const key = `${String(body.symbol ?? '')}|${String(body.timeframe ?? '')}`;
  const state: MapState = { seen: new Set(), calls: new Map() };

  await enqueue(key, async () => {
    activeKeys.add(key);
    try {
      const session = await getSession(key);
      const result = await session.run(input, {
        onNotification: (notification) => {
          for (const event of mapNotification(notification, state)) {
            if (event.type === 'tool' && !event.ok) {
              logger.warn('[dsh] tool failed', { name: event.name, message: event.message });
            }
            emit(event);
          }
        },
      });
      if (!result.finalResponse.trim()) logger.warn('[dsh] analysis finished without an assistant message');
    } finally {
      activeKeys.delete(key);
      lastUsed.set(key, Date.now());
      startSessionEviction();
    }
  });
  emit({ type: 'done' });
}

export function agentStatus() {
  const agent = loadAgentConfig();
  return {
    configured: Boolean(agent.key) && DSH_ENABLED,
    enabled: DSH_ENABLED,
    engine: 'dsh',
    model: DSH_MODEL,
    effort: DSH_REASONING_EFFORT,
    images: true,
  };
}

export async function shutdownDsh(): Promise<void> {
  const current = harness;
  harness = null;
  sessions.clear();
  queues.clear();
  activeKeys.clear();
  lastUsed.clear();
  if (evictTimer) {
    clearInterval(evictTimer);
    evictTimer = null;
  }
  if (patchPath) removePatch(patchPath);
  patchPath = null;
  if (current)
    await current.close().catch((error) => logger.warn('[dsh] close failed', { message: (error as Error).message }));
}
