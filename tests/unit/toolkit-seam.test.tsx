// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { useMemo } from 'react';
import {
  AuiConfig,
  AssistantRuntimeProvider,
  MessageByIndexProvider,
  MessagePrimitive,
  Tools,
  groupPartByType,
  useExternalStoreRuntime,
  type Toolkit,
} from '@assistant-ui/react';

afterEach(cleanup);
const Named = () => <b>backend renderer</b>;
const Hidden = () => null;
const Fallback = () => <i>fallback renderer</i>;
const toolkit = {
  named: { type: 'backend', render: Named, display: 'standalone' },
  hidden: { type: 'backend', render: Hidden },
} satisfies Toolkit;
const content = ['named', 'hidden', 'unknown'].map((toolName) => ({
  type: 'tool-call' as const,
  toolName,
  toolCallId: toolName,
  args: {},
  argsText: '{}',
}));
function Message() {
  return (
    <MessagePrimitive.GroupedParts
      groupBy={groupPartByType({
        'tool-call': ['group-tools'],
        'standalone-tool-call': [],
      })}
    >
      {({ part, children }) =>
        part.type === 'group-tools' ? (
          <section data-testid="activity" data-count={part.indices.length}>
            {children}
          </section>
        ) : part.type === 'tool-call' ? (
          <MessagePrimitive.PartByIndex
            index={content.findIndex((item) => item.toolCallId === part.toolCallId)}
            components={{ tools: { Fallback } }}
          />
        ) : null
      }
    </MessagePrimitive.GroupedParts>
  );
}
function App({ enabled = true }: { enabled?: boolean }) {
  const runtime = useExternalStoreRuntime({
    messages: [{ id: 'message', role: 'assistant' as const, content }],
    convertMessage: (message) => message,
    onNew: async () => {},
  });
  const config = useMemo(
    () => AuiConfig({ tools: Tools({ toolkit: enabled ? toolkit : {} }) }),
    [enabled],
  );
  return (
    <AssistantRuntimeProvider runtime={runtime} config={config}>
      <MessageByIndexProvider index={0}>
        <Message />
      </MessageByIndexProvider>
    </AssistantRuntimeProvider>
  );
}
it('native backend Toolkits register, display standalone, fall back and clean up without executing', async () => {
  const view = render(<App />);
  await waitFor(() => expect(view.queryByText('backend renderer')).not.toBeNull());
  expect(view.getByText('backend renderer').closest('section')).toBeNull();
  // Null rendering does not remove an activity's indices or its tool count.
  expect(view.getByTestId('activity').dataset.count).toBe('2');
  expect(view.getAllByText('fallback renderer')).toHaveLength(1);
  view.rerender(<App enabled={false} />);
  await waitFor(() => expect(view.queryByText('backend renderer')).toBeNull());
  expect(view.getAllByText('fallback renderer')).toHaveLength(3);
  expect(view.getByTestId('activity').dataset.count).toBe('3');
});
