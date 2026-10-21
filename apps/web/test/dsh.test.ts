import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapNotification, type MapState } from '../server/dsh/events.ts';
import { buildPatch } from '../server/dsh/patch.ts';

function state(): MapState {
  return { seen: new Set(), calls: new Map() };
}

function sessionEvent(event: Record<string, unknown>) {
  return { method: 'session.event', params: { sessionId: 'session-test', event } };
}

test('assistant messages map reasoning and answer text once', () => {
  const seen = state();
  const notification = sessionEvent({
    type: 'assistant/message',
    data: {
      message: {
        id: 'message-1',
        content: [
          { type: 'reasoning', text: 'thinking' },
          { type: 'tool-call', name: 'market_bars', arguments: '{}' },
          { type: 'text', text: 'answer' },
        ],
      },
    },
  });

  assert.deepEqual(mapNotification(notification, seen), [
    { type: 'reasoning', delta: 'thinking' },
    { type: 'content', delta: 'answer' },
  ]);
  assert.deepEqual(mapNotification(notification, seen), []);
});

test('tool results resolve the call name and surface failures', () => {
  const seen = state();
  mapNotification(
    sessionEvent({ type: 'tool/call', data: { callId: 'call-1', name: 'mcp__trading__market_bars', arguments: '{}' } }),
    seen,
  );

  const success = mapNotification(
    sessionEvent({
      type: 'tool/result',
      data: {
        message: {
          toolCallId: 'call-1',
          isError: false,
          content: [{ type: 'text', text: '{"count":1}' }],
        },
      },
    }),
    seen,
  );
  assert.deepEqual(success, [
    { type: 'tool', name: 'mcp__trading__market_bars', ok: true, message: '{"count":1}' },
  ]);

  const failure = mapNotification(
    sessionEvent({
      type: 'tool/result',
      data: { message: { toolCallId: 'call-1', isError: true, content: [{ type: 'text', text: 'nope' }] } },
    }),
    seen,
  );
  assert.deepEqual(failure, [{ type: 'tool', name: 'mcp__trading__market_bars', ok: false, message: 'nope' }]);
});

test('generated patches disable host tools and mount MCP servers', () => {
  const patch = buildPatch([
    {
      id: 'mcp-trading',
      serverName: 'trading',
      command: '/usr/local/bin/node',
      args: ['/tmp/trading-mcp.ts'],
      env: { VELA_API_BASE: 'http://127.0.0.1:5174/api/v1' },
    },
  ]);

  for (const id of ['tool-bash', 'tool-fs', 'tool-web', 'subagent', 'skill', 'mcp-resources']) {
    assert.match(patch, new RegExp(`- id: ${id}\\n  disabled: true`));
  }
  assert.match(patch, /id: "mcp-trading"/);
  assert.match(patch, /serverName: "trading"/);
  assert.match(patch, /VELA_API_BASE: "http:\/\/127\.0\.0\.1:5174\/api\/v1"/);
  assert.doesNotMatch(patch, /id: tool-bash\n {2}disabled: false/);
});

test('generated patches honour an empty server list', () => {
  const patch = buildPatch([]);
  assert.match(patch, /disabled: true/);
  assert.doesNotMatch(patch, /- insert:/);
});
