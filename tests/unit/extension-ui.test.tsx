import { ComposerFooterExtensions } from '../../src/browser/extension-ui';
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { useState } from 'react';
import {
  AssistantRuntimeProvider,
  MessageByIndexProvider,
  MessagePrimitive,
  useAuiState,
  useExternalStoreRuntime,
  type ToolCallMessagePartProps,
} from '@assistant-ui/react';
import { ExtensionContext } from '../../src/browser/extension-context';
import type { ExtensionDecoration } from '../../src/browser/extensions';
import { ToolActivity } from '../../src/browser/tool-activity';
import { AssistantFooter } from '../../src/browser/assistant-footer';

afterEach(cleanup);
const part = {
  type: 'tool-call',
  toolName: 'another_extension_tool',
  toolCallId: '2.call',
  args: {},
  argsText: '{}',
  result: 'Original tool result',
} as ToolCallMessagePartProps;
const metadata: ExtensionDecoration = {
  id: 'metadata',
  composerFooter: () => <span>Optional composer footer</span>,
  toolTitleMeta: ({ part }) => <span>Metadata for {part.toolName}</span>,
  toolFooter: ({ part }) => <span>Invocation footer for {part.toolCallId}</span>,
  assistantFooter: () => <span>Optional footer</span>,
  assistantActions: () => <button>Optional reply action</button>,
};
function StatefulFooter() {
  const [count, setCount] = useState(0);
  const id = useAuiState((s) => s.message.id);
  return (
    <button onClick={() => setCount(count + 1)}>
      Footer {id}: {count}
    </button>
  );
}
const independent: ExtensionDecoration = { id: 'independent', assistantFooter: StatefulFooter };
function App({ ui }: { ui: readonly ExtensionDecoration[] }) {
  const runtime = useExternalStoreRuntime({
    messages: [
      {
        id: '2',
        role: 'assistant' as const,
        content: [part, { type: 'text' as const, text: 'Original reply' }],
      },
    ],
    convertMessage: (message) => message,
    onNew: async () => {},
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ExtensionContext
        value={{
          id: 'chat',
          userId: 'user',
          submit: async () => {},
          toolkit: {},
          activity: {},
          ui,
        }}
      >
        <ComposerFooterExtensions />
        <MessageByIndexProvider index={0}>
          <MessagePrimitive.Root>
            <ToolActivity part={part} />
            <AssistantFooter />
          </MessagePrimitive.Root>
        </MessageByIndexProvider>
      </ExtensionContext>
    </AssistantRuntimeProvider>
  );
}
it('composes independent decorations for any shared tool and footer without replacing their state', async () => {
  const view = render(<App ui={[metadata, independent]} />);
  await waitFor(() => expect(view.queryByText('Optional footer')).not.toBeNull());
  expect(view.queryByText('Optional composer footer')).not.toBeNull();
  const copy = view.getByRole('button', { name: 'Copy response' });
  const action = view.getByRole('button', { name: 'Optional reply action' });
  expect(copy.parentElement?.contains(action)).toBe(true);
  const tool = view.getByRole('button', { name: 'Completed: another_extension_tool' });
  expect(tool.textContent).toContain('Metadata for another_extension_tool');
  const invocationFooter = view.getByText('Invocation footer for 2.call');
  expect(tool.contains(invocationFooter)).toBe(false);
  expect(invocationFooter.closest('[hidden]')).toBeNull();
  fireEvent.click(tool);
  expect(view.queryByText('Original tool result')).not.toBeNull();
  fireEvent.click(view.getByRole('button', { name: 'Footer 2: 0' }));
  view.rerender(<App ui={[independent]} />);
  expect(view.queryByText('Optional footer')).toBeNull();
  expect(view.queryByText('Optional composer footer')).toBeNull();
  expect(view.queryByRole('button', { name: 'Optional reply action' })).toBeNull();
  expect(view.queryByText('Metadata for another_extension_tool')).toBeNull();
  expect(view.queryByText('Invocation footer for 2.call')).toBeNull();
  expect(view.queryByText('Original tool result')).not.toBeNull();
  expect(view.queryByRole('button', { name: 'Footer 2: 1' })).not.toBeNull();
  expect(view.getByRole('button', { name: 'Copy response' })).toBe(copy);
  view.rerender(<App ui={[]} />);
  expect(view.queryByRole('button', { name: 'Footer 2: 1' })).toBeNull();
  expect(view.getByRole('button', { name: 'Copy response' })).toBe(copy);
  expect(view.queryByText('Original tool result')).not.toBeNull();
});
it('a failed decoration cannot poison a remaining extension after removal', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const broken: ExtensionDecoration = {
    id: 'broken',
    assistantFooter: () => {
      throw new Error('Optional extension failed');
    },
  };
  try {
    const view = render(<App ui={[broken, independent]} />);
    await waitFor(() => expect(view.queryByRole('button', { name: 'Footer 2: 0' })).not.toBeNull());
    fireEvent.click(view.getByRole('button', { name: 'Footer 2: 0' }));
    view.rerender(<App ui={[independent]} />);
    expect(view.queryByRole('button', { name: 'Footer 2: 1' })).not.toBeNull();
    expect(view.queryByRole('button', { name: 'Copy response' })).not.toBeNull();
  } finally {
    error.mockRestore();
  }
});
