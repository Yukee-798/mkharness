// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useConversationSession } from '../../src/browser/chat/session/use-conversation-session';
import type { ConversationRemote } from '../../src/browser/chat/session/remote';
import type { ConversationSnapshot, HistoryPage } from '../../src/shared/conversation';

// The owned remote seam controls latency without replacing the session coordinator.
afterEach(cleanup);
it('coalesces older-page requests and aborts the owned read when the conversation view unmounts', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(['user', 'owner', 'capabilities'], { extensionIds: [] });
  client.setQueryData(['user', 'owner', 'model-settings'], {
    modelCatalog: { models: [] },
    credentials: [],
  });
  let complete!: (page: HistoryPage) => void;
  let signal: AbortSignal | undefined;
  const older = vi.fn((_id: string, _cursor: string, incoming?: AbortSignal) => {
    signal = incoming;
    return new Promise<HistoryPage>((resolve) => {
      complete = resolve;
    });
  });
  const remote: ConversationRemote = {
    snapshot: async () => ({
      conversationId: 1,
      queue: [],
      queueEdits: [],
      entries: [],
      pending: [],
      stopping: false,
      history: { upperEntryId: 100, revision: 1, annotations: {}, olderCursor: 'older' },
    }),
    history: older,
    create: async () => ({ id: 'chat' }),
    submit: async () => {},
    stop: async () => {},
    queue: async () => ({ queue: [] }),
    acknowledgeQueueEdit: async () => ({ acknowledged: true }),
    observe: async () => new Response(),
  };
  const hook = renderHook(() => useConversationSession({ id: 'chat', userId: 'owner', remote }), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  try {
    await waitFor(() => expect(hook.result.current.view.hasOlder).toBe(true));
    let flight!: Promise<void>;
    act(() => {
      flight = hook.result.current.loadOlder();
      void hook.result.current.loadOlder();
    });
    expect(older).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(false);
    hook.unmount();
    expect(signal?.aborted).toBe(true);
    complete({ entries: [], history: { upperEntryId: 100, revision: 1, annotations: {} } });
    await flight;
    expect(older).toHaveBeenCalledWith('chat', 'older', signal, 1);
  } finally {
    hook.unmount();
    client.clear();
  }
});

it('discovers lost draft transfers and retains them on failed acknowledgement without reviving acknowledged receipts', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(['user', 'owner', 'capabilities'], { extensionIds: [] });
  client.setQueryData(['user', 'owner', 'model-settings'], {
    modelCatalog: { models: [] },
    credentials: [],
  });
  const receipt = { runId: 'withdrawn-run', expiresAt: Date.now() + 60_000 };
  let server: ConversationSnapshot = {
    conversationId: 7,
    entries: [],
    pending: [],
    queue: [],
    queueEdits: [],
    stopping: false,
    history: { upperEntryId: 0, revision: 0, annotations: {} },
  };
  const snapshot = vi.fn(async () => structuredClone(server));
  const acknowledge = vi
    .fn()
    .mockRejectedValueOnce(new Error('Acknowledgement lost'))
    .mockResolvedValue({ acknowledged: true });
  const remote: ConversationRemote = {
    snapshot,
    history: async () => ({ entries: [], history: server.history }),
    create: async () => ({ id: 'chat' }),
    submit: async () => {},
    stop: async () => {},
    queue: async () => {
      server = { ...server, queueEdits: [receipt] };
      throw new Error('Edit response lost');
    },
    acknowledgeQueueEdit: acknowledge,
    observe: async () => new Response(),
  };
  const hook = renderHook(() => useConversationSession({ id: 'chat', userId: 'owner', remote }), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  try {
    await waitFor(() => expect(hook.result.current.view.composerReady).toBe(true));
    await act(async () => {
      await expect(hook.result.current.actOnQueue(receipt.runId, 'edit')).rejects.toThrow(
        'Edit response lost',
      );
    });
    expect(hook.result.current.view.snapshot?.queueEdits).toEqual([receipt]);
    await act(async () => {
      await expect(hook.result.current.acknowledgeQueueEdit(receipt.runId)).rejects.toThrow(
        'Acknowledgement lost',
      );
    });
    expect(hook.result.current.view.snapshot?.queueEdits).toEqual([receipt]);
    await act(async () => {
      await hook.result.current.acknowledgeQueueEdit(receipt.runId);
    });
    expect(acknowledge).toHaveBeenLastCalledWith('chat', receipt.runId, 7);
    expect(hook.result.current.view.snapshot?.queueEdits).toEqual([]);
    act(() => hook.result.current.reconnect());
    await waitFor(() => expect(snapshot).toHaveBeenCalledTimes(3));
    expect(hook.result.current.view.snapshot?.queueEdits).toEqual([]);
  } finally {
    hook.unmount();
    client.clear();
  }
});
