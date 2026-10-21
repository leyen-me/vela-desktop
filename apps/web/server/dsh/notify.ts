export type DshNotificationEvent =
  | { type: 'reasoning'; text: string }
  | { type: 'content'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; name: string; ok: boolean; text: string; value: unknown };

type Notification = { method: string; params: Record<string, unknown> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function blockText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (isRecord(block) && typeof block.text === 'string' ? block.text : ''))
    .join('');
}

/**
 * Translates dsh session notifications into the vocabulary both the live panel
 * and the backtest loop consume. One mapper instance belongs to one agent run.
 */
export function createNotificationMapper(): (notification: Notification) => DshNotificationEvent[] {
  const seen = new Set<string>();
  const callNames = new Map<string, string>();

  return (notification) => {
    if (notification.method !== 'session.event') return [];
    const event = notification.params.event;
    if (!isRecord(event) || typeof event.type !== 'string') return [];
    const data = isRecord(event.data) ? event.data : {};

    if (event.type === 'tool/call') {
      const id = typeof data.callId === 'string' ? data.callId : '';
      const name = typeof data.name === 'string' ? data.name : 'tool';
      if (id) callNames.set(id, name);
      return [{ type: 'tool_call', id, name, args: parseJson(String(data.arguments ?? '{}')) }];
    }

    if (event.type === 'tool/result') {
      const message = isRecord(data.message) ? data.message : {};
      const source = isRecord(message.source) ? message.source : {};
      const id =
        (typeof message.toolCallId === 'string' && message.toolCallId) ||
        (typeof source.callId === 'string' && source.callId) ||
        '';
      const name = (id && callNames.get(id)) || 'tool';
      const text = blockText(message.content);
      return [
        { type: 'tool_result', id, name, ok: message.isError !== true, text, value: parseJson(text) },
      ];
    }

    if (event.type === 'assistant/message') {
      const message = isRecord(data.message) ? data.message : {};
      const id = typeof message.id === 'string' ? message.id : '';
      if (id) {
        if (seen.has(id)) return [];
        seen.add(id);
      }
      const blocks = Array.isArray(message.content) ? message.content : [];
      const out: DshNotificationEvent[] = [];
      for (const block of blocks) {
        if (!isRecord(block) || typeof block.text !== 'string' || !block.text) continue;
        if (block.type === 'reasoning') out.push({ type: 'reasoning', text: block.text });
        else if (block.type === 'text') out.push({ type: 'content', text: block.text });
      }
      return out;
    }

    return [];
  };
}
