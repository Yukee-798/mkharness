import { afterEach, expect, it, vi } from 'vitest';
import { conversationRemote } from '../../src/browser/chat/session/remote';

afterEach(() => vi.restoreAllMocks());
it.each([
  { accepted: true },
  { accepted: true, observation: { conversationId: 0, pending: [] } },
  {
    accepted: true,
    observation: { conversationId: 7, pending: [{ operationId: 'run', status: ['running'] }] },
  },
])('falls back safely for legacy or malformed observation receipts (%j)', async (receipt) => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(receipt));
  expect(
    await conversationRemote.submit('chat', { runId: crypto.randomUUID(), text: 'Hello' }),
  ).toBeUndefined();
});
it('decodes an authoritative receipt at the HTTP seam and preserves native target identity', async () => {
  const observation = {
    conversationId: 7,
    pending: [{ operationId: 'native-run', status: 'queued' }],
  };
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({ accepted: true, observation }));
  expect(
    await conversationRemote.submit('chat', { runId: crypto.randomUUID(), text: 'Hello' }, 7),
  ).toEqual(observation);
  expect(fetch.mock.calls[0][0]).toBe('/api/conversations/chat/runs?conversationId=7');
});
