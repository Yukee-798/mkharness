import { expect, it } from 'vitest';
import { mcpIntentUnresolved, type McpIntent } from '../../src/server/mcp-intents';

it('requires a native completed result receipt, not just a returned remote response', () => {
  const intent: McpIntent = {
    taskId: 1,
    runId: 'run',
    callId: 'call',
    serverId: 'service',
    endpoint: 'https://example.test/mcp',
    toolName: 'mutate',
    status: 'responded',
  };
  const completed = {
    state: { status: 'terminal', outcome: { status: 'completed', result: { entryId: 4 } } },
  } as const;
  expect(mcpIntentUnresolved(intent, completed)).toBe(false);
  expect(mcpIntentUnresolved(intent)).toBe(true);
  expect(mcpIntentUnresolved(intent, { state: { status: 'running', checkpoint: {} } })).toBe(true);
  expect(
    mcpIntentUnresolved(intent, {
      state: { status: 'terminal', outcome: { status: 'aborted', result: { entryId: 4 } } },
    }),
  ).toBe(true);
  expect(mcpIntentUnresolved({ ...intent, status: 'unknown' }, completed)).toBe(true);
  expect(mcpIntentUnresolved({ ...intent, status: 'dispatching' }, completed)).toBe(true);
});
