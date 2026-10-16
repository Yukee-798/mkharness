// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import {
  AuiConfig,
  AssistantRuntimeProvider,
  MessageByIndexProvider,
  MessagePrimitive,
  Tools,
  useExternalStoreRuntime,
} from '@assistant-ui/react';
import { toolkit as exampleToolkit } from '../../src/extensions/example/browser';
import { ToolProgressFold } from '../../src/shared/tool-progress';
import { loadBrowserExtensions } from '../../src/browser/extensions/extensions';
afterEach(cleanup);
it('does not evaluate unselected modules and distinguishes missing native Toolkit results', async () => {
  const openui = vi.fn(async () => ({ toolkit: {} }));
  await loadBrowserExtensions(['example'], {
    openui,
    example: async () => ({ toolkit: exampleToolkit }),
  });
  expect(openui).not.toHaveBeenCalled();
  function App({ enabled }: { enabled: boolean }) {
    const runtime = useExternalStoreRuntime({
      messages: [
        {
          id: 'm',
          role: 'assistant' as const,
          content: [
            {
              type: 'tool-call' as const,
              toolName: 'describe_text',
              toolCallId: 'c',
              args: { text: 'abc' },
              argsText: '{"text":"abc"}',
              result: { characters: 3 },
            },
          ],
        },
      ],
      convertMessage: (message) => message,
      onNew: async () => {},
    });
    return (
      <AssistantRuntimeProvider
        runtime={runtime}
        config={AuiConfig({ tools: Tools({ toolkit: enabled ? exampleToolkit : {} }) })}
      >
        <MessageByIndexProvider index={0}>
          <MessagePrimitive.Parts
            components={{ tools: { Fallback: () => <span>fallback</span> } }}
          />
        </MessageByIndexProvider>
      </AssistantRuntimeProvider>
    );
  }
  const view = render(<App enabled />);
  await waitFor(() => expect(view.queryByText('The text contains 3 characters.')).not.toBeNull());
  view.rerender(<App enabled={false} />);
  await waitFor(() => expect(view.queryByText('The text contains 3 characters.')).toBeNull());
  expect(view.getByText('fallback')).toBeDefined();
});
it('detects removal of the native progress bridge instead of accepting snapshots as real-time progress', () => {
  const entry = {
    id: 2,
    model: [
      { role: 'assistant', content: [{ type: 'toolCall', id: 'c', name: 'probe', arguments: {} }] },
    ],
  } as any;
  const baseline = new ToolProgressFold(),
    ablated = new ToolProgressFold();
  for (const fold of [baseline, ablated]) fold.round(entry);
  baseline.update('2.c', { output: { append: 'live progress' } });
  const project =
    () =>
    ({ output }: any) =>
      output ?? '';
  expect(baseline.project(project)['2.c']).toMatchObject({
    status: 'running',
    value: 'live progress',
  });
  expect(ablated.project(project)['2.c']).not.toEqual(baseline.project(project)['2.c']);
});
