// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useConversationSession } from '../../src/browser/chat/session/use-conversation-session';
import type { ConversationRemote } from '../../src/browser/chat/session/remote';
import type { HistoryPage } from '../../src/shared/conversation';

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
    expect(older).toHaveBeenCalledWith('chat', 'older', signal);
  } finally {
    hook.unmount();
    client.clear();
  }
});
