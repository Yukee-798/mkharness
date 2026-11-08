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

it.each(['accepted', 'legacy', 'wrong-target', 'completed', 'retry'] as const)(
  'attaches from an authoritative admission without a snapshot round trip (%s)',
  async (mode) => {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    client.setQueryData(['user', 'owner', 'capabilities'], { extensionIds: [] });
    client.setQueryData(['user', 'owner', 'model-settings'], {
      modelCatalog: { models: [] },
      credentials: [],
    });
    const base: ConversationSnapshot = {
      conversationId: 7,
      entries: [],
      pending: [],
      queue: [],
      queueEdits: [],
      stopping: false,
      history: { upperEntryId: 0, revision: 0, annotations: {} },
    };
    // A follow-up snapshot intentionally never resolves. Events must open without it.
    const snapshot = vi
      .fn()
      .mockResolvedValueOnce(base)
      .mockImplementation(() => new Promise(() => {}));
    const observe = vi.fn(
      async (_id: string, runId: string) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ type: 'RUN_STARTED', threadId: 'chat', runId })}\n\n`,
                ),
              );
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const submit = vi.fn(async (_id: string, command: { runId: string }) => {
      if (mode === 'retry' && submit.mock.calls.length === 1) throw new Error('Lost receipt');
      if (mode === 'legacy') return;
      return {
        conversationId: mode === 'wrong-target' ? 9 : 7,
        pending:
          mode === 'completed' ? [] : [{ operationId: command.runId, status: 'running' as const }],
      };
    });
    const remote: ConversationRemote = {
      snapshot,
      observe,
      submit,
      create: async () => ({ id: 'chat' }),
      history: async () => ({ entries: [], history: base.history }),
      stop: async () => {},
      queue: async () => ({ queue: [] }),
      acknowledgeQueueEdit: async () => {},
    };
    const hook = renderHook(() => useConversationSession({ id: 'chat', userId: 'owner', remote }), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    try {
      await waitFor(() => expect(hook.result.current.view.composerReady).toBe(true));
      await act(async () => {
        if (mode === 'retry')
          await expect(hook.result.current.submit('hello')).rejects.toThrow('Lost receipt');
        else await hook.result.current.submit('hello');
      });
      if (mode === 'retry') {
        await waitFor(() => expect(hook.result.current.view.submissionFailed).toBe(true));
        await act(async () => hook.result.current.retrySubmission());
        expect(submit.mock.calls[1]).toEqual(submit.mock.calls[0]);
      }
      if (mode === 'accepted' || mode === 'retry') {
        await waitFor(() => expect(observe).toHaveBeenCalledOnce());
        expect(snapshot).toHaveBeenCalledOnce();
        expect(observe.mock.calls[0].slice(0, 2)).toEqual(['chat', submit.mock.calls[0][1].runId]);
      } else {
        await waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
        expect(observe).not.toHaveBeenCalled();
      }
    } finally {
      hook.unmount();
      client.clear();
    }
  },
);

it('preserves accepted work when a pre-admission reconnect snapshot arrives late', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(['user', 'owner', 'capabilities'], { extensionIds: [] });
  client.setQueryData(['user', 'owner', 'model-settings'], {
    modelCatalog: { models: [] },
    credentials: [],
  });
  const idle: ConversationSnapshot = {
    conversationId: 7,
    entries: [],
    pending: [],
    queue: [],
    queueEdits: [],
    stopping: false,
    history: { upperEntryId: 0, revision: 0, annotations: {} },
  };
  let release!: (value: ConversationSnapshot) => void;
  const snapshot = vi
    .fn()
    .mockResolvedValueOnce(structuredClone(idle))
    .mockImplementation(
      () =>
        new Promise<ConversationSnapshot>((resolve) => {
          release = resolve;
        }),
    );
  const stop = vi.fn(async () => {});
  const remote: ConversationRemote = {
    snapshot,
    submit: async (_id, command) => ({
      conversationId: 7,
      pending: [{ operationId: command.runId, status: 'running' }],
    }),
    observe: async (_id, runId) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ type: 'RUN_STARTED', threadId: 'chat', runId })}\n\n`,
              ),
            );
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    create: async () => ({ id: 'chat' }),
    history: async () => ({ entries: [], history: idle.history }),
    stop,
    queue: async () => ({ queue: [] }),
    acknowledgeQueueEdit: async () => {},
  };
  const hook = renderHook(() => useConversationSession({ id: 'chat', userId: 'owner', remote }), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  try {
    await waitFor(() => expect(hook.result.current.view.composerReady).toBe(true));
    act(() => hook.result.current.reconnect());
    await waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
    await act(async () => {
      await hook.result.current.submit('Accepted after read began');
    });
    expect(hook.result.current.view.hasPending).toBe(true);
    await act(async () => {
      release(structuredClone(idle));
    });
    expect(hook.result.current.view.hasPending).toBe(true);
    await act(async () => {
      await hook.result.current.stop();
    });
    expect(stop).toHaveBeenCalledExactlyOnceWith('chat', 7);
    await waitFor(() => expect(snapshot).toHaveBeenCalledTimes(3));
    await act(async () => {
      release(structuredClone(idle));
    });
    expect(hook.result.current.view.hasPending).toBe(false);
  } finally {
    hook.unmount();
    client.clear();
  }
});
