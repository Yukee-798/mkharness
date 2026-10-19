// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { StrictMode, startTransition } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Chat } from '../../src/browser/chat/Chat';
import { usage } from '../fixture-model';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each([false, true])(
  'can navigate away from populated conversations and restore cached messages repeatedly (running=%s)',
  async (running) => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    });
    const streams: ReadableStreamDefaultController[] = [];
    const send = (event: unknown) =>
      streams.at(-1)?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const path = String(input);
      if (path === '/api/capabilities') return Response.json({ extensionIds: [] });
      if (path === '/api/settings/models')
        return Response.json({ modelCatalog: { models: [] }, credentials: [] });
      if (path.includes('/events')) {
        const events = [
          { type: 'RUN_STARTED', threadId: 'a', runId: 'run' },
          { type: 'TEXT_MESSAGE_START', messageId: 'draft:run:1', role: 'assistant' },
          { type: 'TEXT_MESSAGE_CONTENT', messageId: 'draft:run:1', delta: 'Live reply' },
          {
            type: 'TOOL_CALL_START',
            toolCallId: 'live-tool',
            toolCallName: 'unknown',
            parentMessageId: 'draft:run:1',
          },
          { type: 'TOOL_CALL_ARGS', toolCallId: 'live-tool', delta: '{}' },
        ];
        return new Response(
          new ReadableStream({
            start(controller) {
              streams.push(controller);
              for (const event of events)
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      if (path.endsWith('/snapshot')) {
        const id = path.includes('/a/') ? 'a' : 'b';
        return Response.json({
          conversationId: 1,
          entries: [
            {
              id: 1,
              conversationId: 1,
              kind: 'message',
              model: [
                {
                  role: 'assistant',
                  content: [
                    { type: 'thinking', thinking: 'Checking.' },
                    { type: 'text', text: `Reply ${id}` },
                  ],
                  api: 'openai-responses',
                  provider: 'fixture',
                  model: 'fixture',
                  usage,
                  stopReason: 'stop',
                  timestamp: 0,
                },
              ],
            },
          ],
          pending: running ? [{ operationId: 'run', status: 'running' }] : [],
          queue: [],
          queueEdits: [],
          stopping: false,
          history: { upperEntryId: 1, revision: 1, annotations: {} },
        });
      }
      return new Response('Not found', { status: 404 });
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const ui = (route: string) => (
      <StrictMode>
        <QueryClientProvider client={client}>
          {route === 'other' ? <div>Other route</div> : <Chat id={route} userId="owner" />}
        </QueryClientProvider>
      </StrictMode>
    );
    const view = render(ui('a'));
    try {
      await view.findByText('Reply a');
      if (running) await view.findByText('Live reply');
      for (let i = 0; i < 12; i++) {
        const route = i % 2 ? 'a' : 'b';
        if (i % 3 === 0) {
          await act(async () => startTransition(() => view.rerender(ui('other'))));
          expect(view.getByText('Other route')).toBeTruthy();
        }
        await act(async () => {
          startTransition(() => view.rerender(ui(route)));
          if (running) {
            send({
              type: 'MESSAGES_SNAPSHOT',
              messages: [{ id: '1', role: 'assistant', content: 'Replaced' }],
            });
            send({ type: 'TEXT_MESSAGE_START', messageId: `new-${i}`, role: 'assistant' });
            send({ type: 'TEXT_MESSAGE_CONTENT', messageId: `new-${i}`, delta: 'New part' });
          }
        });
        await waitFor(() => expect(view.getByText(`Reply ${route}`)).toBeTruthy());
        if (running) await view.findByText('Live reply');
      }
    } finally {
      view.unmount();
      client.clear();
    }
  },
);
