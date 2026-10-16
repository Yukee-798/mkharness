// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import {
  AssistantRuntimeProvider,
  MessageByIndexProvider,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { Assistant } from '../../src/browser/chat/messages/AssistantMessage';
import { ExtensionContext } from '../../src/browser/extensions/extension-context';
import { DraftProjection, toMessages } from '../../src/shared/stream';
import { fromAgUiMessages } from '@assistant-ui/react-ag-ui';
import { RunAggregator } from '../../node_modules/@assistant-ui/react-ag-ui/dist/runtime/adapter/run-aggregator.js';
import { parseAgUiEvent } from '../../node_modules/@assistant-ui/react-ag-ui/dist/runtime/event-parser.js';
import { usage } from '../fixture-model';
import type { EntryRecord } from '@earendil-works/pi-durable';

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
afterEach(cleanup);

const call = (id: string, argsText = '{}', result?: string) => ({
  type: 'tool-call' as const,
  toolCallId: id,
  toolName: 'unknown',
  args: {},
  argsText,
  ...(result === undefined ? {} : { result }),
});
function App({ content }: { content: ThreadMessageLike['content'] }) {
  const runtime = useExternalStoreRuntime({
    messages: [{ id: 'message', role: 'assistant' as const, content }],
    isRunning: true,
    convertMessage: (message) => message,
    onNew: async () => {},
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ExtensionContext
        value={{ id: 'chat', userId: 'user', submit: async () => {}, toolkit: {}, activity: {} }}
      >
        <MessageByIndexProvider index={0}>
          <Assistant />
        </MessageByIndexProvider>
      </ExtensionContext>
    </AssistantRuntimeProvider>
  );
}
it('keeps existing tool DOM and disclosure state as calls, arguments and results stream in', async () => {
  const view = render(<App content={[call('one')]} />);
  const first = view.container.querySelector('[data-slot="tool-call"] > button')!;
  fireEvent.click(first);
  await waitFor(() => expect(first.getAttribute('aria-expanded')).toBe('true'));
  view.rerender(<App content={[call('one'), call('two')]} />);
  await waitFor(() =>
    expect(view.container.querySelectorAll('[data-slot="tool-call"]')).toHaveLength(2),
  );
  expect(view.container.querySelector('[data-slot="tool-call"] > button')).toBe(first);
  expect(first.getAttribute('aria-expanded')).toBe('true');
  view.rerender(<App content={[call('one', '{"value":1}', 'done'), call('two'), call('three')]} />);
  await waitFor(() => expect(view.getByText('done')).toBeTruthy());
  expect(view.container.querySelector('[data-slot="tool-call"] > button')).toBe(first);
  expect(first.getAttribute('aria-expanded')).toBe('true');
  const group = view.container.querySelector('[data-slot="tool-group-trigger"]')!;
  fireEvent.click(group);
  await waitFor(() => expect(group.getAttribute('aria-expanded')).toBe('false'));
  view.rerender(
    <App
      content={[call('one', '{"value":2}', 'done'), call('two'), call('three'), call('four')]}
    />,
  );
  expect(view.container.querySelector('[data-slot="tool-group-trigger"]')).toBe(group);
  expect(group.getAttribute('aria-expanded')).toBe('false');
});

it('only shows the empty-message thinking indicator before any visible activity arrives', () => {
  const view = render(<App content={[]} />);
  expect(view.getByText('Thinking…')).toBeTruthy();
  view.rerender(<App content={[call('one')]} />);
  expect(view.queryByText('Thinking…')).toBeNull();
});

it('keeps the tool renderer when a committed snapshot inserts reasoning before its calls', async () => {
  const view = render(<App content={[call('one'), call('two')]} />);
  const first = view.container.querySelector('[data-slot="tool-call"] > button')!;
  fireEvent.click(first);
  view.rerender(
    <App
      content={[
        { type: 'reasoning', text: 'Checking sources.' },
        call('one', '{}', 'done'),
        call('two'),
      ]}
    />,
  );
  await waitFor(() => expect(view.getByText('done')).toBeTruthy());
  expect(view.container.querySelector('[data-slot="tool-call"] > button')).toBe(first);
  expect(first.getAttribute('aria-expanded')).toBe('true');
});

it('clusters later reasoning into the original disclosure without inserting another row above tools', async () => {
  const thoughts = (text: string) => ({ type: 'reasoning' as const, text });
  const tools = [call('one'), call('two'), call('three'), call('four')];
  const view = render(<App content={[thoughts('Initial checks.'), ...tools]} />);
  const reasoning = view.container.querySelector('[data-slot="reasoning-trigger"]')!;
  const group = view.container.querySelector('[data-slot="tool-group-trigger"]')!;
  expect(reasoning.getAttribute('aria-expanded')).toBe('false');
  view.rerender(
    <App content={[thoughts('Initial checks.'), ...tools, thoughts('More checks.')]} />,
  );
  expect(view.container.querySelectorAll('[data-slot="reasoning-trigger"]')).toHaveLength(1);
  expect(view.container.querySelector('[data-slot="reasoning-trigger"]')).toBe(reasoning);
  expect(view.container.querySelector('[data-slot="tool-group-trigger"]')).toBe(group);
  expect(reasoning.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(reasoning);
  await waitFor(() => expect(view.getByText('More checks.')).toBeTruthy());
  // The installed snapshot adapter restores all reasoning ahead of the tools.
  // Both shapes keep the same disclosure and manual choice.
  view.rerender(
    <App content={[thoughts('Initial checks.'), thoughts('More checks.'), ...tools]} />,
  );
  expect(view.container.querySelector('[data-slot="reasoning-trigger"]')).toBe(reasoning);
  expect(view.container.querySelector('[data-slot="tool-group-trigger"]')).toBe(group);
  expect(reasoning.getAttribute('aria-expanded')).toBe('true');
});

it('keeps the same reasoning and tool disclosure from native Pi draft projection to restored snapshot', () => {
  let content: ThreadMessageLike['content'] = [];
  const aggregator = new RunAggregator({
    showThinking: true,
    logger: { debug() {}, error() {} },
    emit: (update) => {
      content = update.content;
    },
  });
  aggregator.handle({ type: 'RUN_STARTED', runId: 'run' });
  const projection = new DraftProjection('draft:run:1', (event) => {
    const parsed = parseAgUiEvent(event);
    if (parsed) aggregator.handle(parsed);
  });
  const message = {
    role: 'assistant' as const,
    api: 'openai-responses' as const,
    provider: 'fixture',
    model: 'fixture',
    usage,
    stopReason: 'toolUse' as const,
    timestamp: 0,
    content: [
      { type: 'thinking' as const, thinking: 'Initial checks.' },
      ...['one', 'two', 'three', 'four'].map((id) => ({
        type: 'toolCall' as const,
        id,
        name: 'unknown',
        arguments: {},
      })),
    ],
  };
  expect(projection.publish(message)).toBe(true);
  const view = render(<App content={content} />);
  const reasoning = view.container.querySelector('[data-slot="reasoning-trigger"]')!;
  const group = view.container.querySelector('[data-slot="tool-group-trigger"]')!;
  message.content.push({ type: 'thinking', thinking: 'Later checks.' });
  expect(projection.publish(message)).toBe(true);
  view.rerender(<App content={content} />);
  expect(view.container.querySelectorAll('[data-slot="reasoning-trigger"]')).toHaveLength(1);
  expect(view.container.querySelector('[data-slot="reasoning-trigger"]')).toBe(reasoning);
  expect(view.container.querySelector('[data-slot="tool-group-trigger"]')).toBe(group);
  expect(reasoning.getAttribute('aria-expanded')).toBe('false');
  const restored = fromAgUiMessages(
    toMessages(
      [
        {
          id: 1 as EntryRecord['id'],
          conversationId: 1 as EntryRecord['conversationId'],
          kind: 'message',
          model: [message],
        },
      ],
      new Map([['1', 'draft:run:1']]),
    ),
  );
  view.rerender(<App content={restored[0]!.content} />);
  expect(view.container.querySelector('[data-slot="reasoning-trigger"]')).toBe(reasoning);
  expect(view.container.querySelector('[data-slot="tool-group-trigger"]')).toBe(group);
  expect(reasoning.getAttribute('aria-expanded')).toBe('false');
});

it('updates the group completion label in place instead of replacing its animated text node', () => {
  const view = render(<App content={[call('one'), call('two')]} />);
  const trigger = view.container.querySelector('[data-slot="tool-group-trigger"]')!;
  const label = trigger.querySelector('.shimmer')!;
  expect(label).toBeTruthy();
  view.rerender(<App content={[call('one', '{}', 'done'), call('two', '{}', 'done')]} />);
  expect(view.container.querySelector('[data-slot="tool-group-trigger"]')).toBe(trigger);
  expect(trigger.textContent).toBe('Called 2 tools');
  expect(trigger.contains(label)).toBe(true);
  expect(label.classList.contains('shimmer')).toBe(false);
});
