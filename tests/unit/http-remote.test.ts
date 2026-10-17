import { afterEach, expect, it, vi } from 'vitest';
import { conversationRemote } from '../../src/browser/chat/session/remote';

afterEach(() => vi.unstubAllGlobals());

it('rejects the old snapshot envelope after one request without fetching its cursor', async () => {
  const network = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({
      entries: [],
      pending: [],
      stopping: false,
      cursor: { before: 100 },
    }),
  );
  vi.stubGlobal('fetch', network);
  await expect(conversationRemote.snapshot('chat')).rejects.toThrow('protocol_mismatch');
  expect(network).toHaveBeenCalledOnce();
  expect(network.mock.calls[0]![0]).toBe('/api/conversations/chat/snapshot');
});

it('uses explicit native targets and the same remote seam for snapshot and observation', async () => {
  const network = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({
      conversationId: 7,
      entries: [],
      pending: [],
      queue: [],
      queueEdits: [],
      stopping: false,
      history: { upperEntryId: 0, revision: 0, annotations: {} },
    }),
  );
  vi.stubGlobal('fetch', network);
  expect((await conversationRemote.snapshot('chat', undefined, 7)).conversationId).toBe(7);
  const controller = new AbortController();
  await conversationRemote.observe('chat', 'run', controller.signal, 7);
  expect(network.mock.calls[0]![0]).toBe('/api/conversations/chat/snapshot?conversationId=7');
  expect(network.mock.calls[1]![0]).toBe(
    '/api/conversations/chat/runs/run/events?conversationId=7',
  );
});
