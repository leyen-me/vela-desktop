export type AgentStreamEvent =
  | { type: 'reasoning'; delta: string }
  | { type: 'content'; delta: string }
  | { type: 'tool'; name: string; ok: boolean; message?: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

type HarnessNotification = { method: string; params: Record<string, unknown> };

type AssistantBlock = { type?: unknown; text?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Maps dsh session notifications onto the panel's SSE vocabulary. dsh delivers
 * durable step facts rather than token deltas, so reasoning and answer text arrive
 * once per assistant step; tool calls and results still stream as they happen.
 */
export type MapState = { seen: Set<string>; calls: Map<string, string> };

export function mapNotification(notification: HarnessNotification, state: MapState): AgentStreamEvent[] {
  if (notification.method !== 'session.event') return [];
  const event = notification.params.event;
  if (!isRecord(event) || typeof event.type !== 'string') return [];
  const data = isRecord(event.data) ? event.data : {};

  if (event.type === 'tool/call') {
    const callId = typeof data.callId === 'string' ? data.callId : '';
    const name = typeof data.name === 'string' ? data.name : 'tool';
    if (callId) state.calls.set(callId, name);
    return [];
  }

  if (event.type === 'assistant/message') {
    const message = isRecord(data.message) ? data.message : {};
    const id = typeof message.id === 'string' ? message.id : '';
    if (id) {
      if (state.seen.has(id)) return [];
      state.seen.add(id);
    }
    const blocks = Array.isArray(message.content) ? (message.content as AssistantBlock[]) : [];
    const out: AgentStreamEvent[] = [];
    for (const block of blocks) {
      if (typeof block.text !== 'string' || block.text.length === 0) continue;
      if (block.type === 'reasoning') out.push({ type: 'reasoning', delta: block.text });
      else if (block.type === 'text') out.push({ type: 'content', delta: block.text });
    }
    return out;
  }

  if (event.type === 'tool/result') {
    const message = isRecord(data.message) ? data.message : {};
    const source = isRecord(message.source) ? message.source : {};
    const callId =
      (typeof message.toolCallId === 'string' && message.toolCallId) ||
      (typeof source.callId === 'string' && source.callId) ||
      '';
    const name = (callId && state.calls.get(callId)) || (typeof data.name === 'string' ? data.name : 'tool');
    const content = Array.isArray(message.content) ? (message.content as AssistantBlock[]) : [];
    const text = content
      .map((block) => (typeof block.text === 'string' ? block.text : ''))
      .join(' ')
      .slice(0, 500);
    return [{ type: 'tool', name, ok: message.isError !== true, message: text || undefined }];
  }

  return [];
}
