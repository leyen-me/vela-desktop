import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger.ts';
import { LIVE_PERSONA, buildAgentPrompt, loadAgentConfig } from '../agent.ts';
import { DSH_ENABLED, DSH_HOME, DSH_MODEL, DSH_REASONING_EFFORT, DSH_TURN_TIMEOUT_MS, ensureDshDirs } from './config.ts';
import { removePatch, writePatch, type McpServerPatch } from './patch.ts';
import { DshRuntime } from './runtime.ts';
import type { DshNotificationEvent } from './notify.ts';

export type AgentStreamEvent =
  | { type: 'reasoning'; delta: string }
  | { type: 'content'; delta: string }
  | { type: 'tool'; name: string; ok: boolean; message?: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

let runtime: DshRuntime | null = null;
let patchPath: string | null = null;

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

function getRuntime(): DshRuntime {
  if (runtime) return runtime;
  ensureDshDirs();
  patchPath = writePatch('live.patch.yml', mcpServers(), { personaPrefix: LIVE_PERSONA });
  runtime = new DshRuntime({
    patchFile: patchPath,
    dshHome: DSH_HOME,
    requestTimeoutMs: DSH_TURN_TIMEOUT_MS,
  });
  return runtime;
}

function sessionIdFor(key: string): string {
  return `session-${createHash('sha256').update(`vela-live:${key}`).digest('hex').slice(0, 32)}`;
}

function adaptEvent(event: DshNotificationEvent): AgentStreamEvent | null {
  if (event.type === 'reasoning') return { type: 'reasoning', delta: event.text };
  if (event.type === 'content') return { type: 'content', delta: event.text };
  if (event.type === 'tool_result') {
    return { type: 'tool', name: event.name, ok: event.ok, message: event.text.slice(0, 500) || undefined };
  }
  return null;
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

export async function streamAnalysis(
  body: AnalysisBody,
  emit: (event: AgentStreamEvent) => void,
): Promise<void> {
  const agent = loadAgentConfig();
  if (!agent.key)
    throw new Error('未检测到 DEEPSEEK_API_KEY，请设置环境变量后重启应用（或在 data/agent.json 中配置 apiKey）');
  const images = collectImages(body);
  const prompt = await buildAgentPrompt(body as Record<string, unknown>, images.length > 0);
  const userText = lastUserText(body);
  const text = userText ? `${prompt}\n\n本轮用户消息：\n${userText}` : prompt;
  const input = images.length > 0 ? [{ type: 'text' as const, text }, ...images.map(imageBlock)] : text;
  const key = `${String(body.symbol ?? '')}|${String(body.timeframe ?? '')}`;

  const result = await getRuntime().run(
    key,
    sessionIdFor(key),
    input,
    (event) => {
      const mapped = adaptEvent(event);
      if (mapped) emit(mapped);
    },
    { resume: true },
  );
  if (!result.finalResponse.trim()) logger.warn('[dsh] analysis finished without an assistant message');
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
  const current = runtime;
  runtime = null;
  if (patchPath) removePatch(patchPath);
  patchPath = null;
  if (current) await current.close();
}
