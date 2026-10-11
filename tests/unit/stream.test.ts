import { it, expect } from 'vitest';
import {
  StreamFold,
  DraftProjection,
  openArgs,
  toMessages,
  browserEntries,
  toolResultEvent,
} from '../../src/shared/stream';
import { usage } from '../fixture-model';
import { USER_ACTION_CONTEXT } from '../../src/shared/contracts';
import { fromAgUiMessages } from '@assistant-ui/react-ag-ui';
import type { ThreadAssistantMessagePart } from '@assistant-ui/react';
// Exercise the installed adapter's actual part creation and message-boundary behavior.
import { RunAggregator } from '../../node_modules/@assistant-ui/react-ag-ui/dist/runtime/adapter/run-aggregator.js';
import { parseAgUiEvent } from '../../node_modules/@assistant-ui/react-ag-ui/dist/runtime/event-parser.js';
const message = (content: any[]) => ({
  role: 'assistant' as const,
  content,
  api: 'openai-responses',
  provider: 'fixture',
  model: 'fixture',
  usage,
  stopReason: 'toolUse' as const,
  timestamp: 0,
});
it.each(['text', 'openui'])(
  'creates reasoning ahead of the SDK %s part without mixing rounds',
  (kind) => {
    let latest: { content?: readonly ThreadAssistantMessagePart[] } = {};
    let previous: typeof latest | undefined;
    const aggregator = new RunAggregator({
      showThinking: true,
      logger: { debug() {}, error() {} },
      emit: (update) => (latest = update),
      onTextMessageStart: () => (previous = latest),
    });
    aggregator.handle({ type: 'RUN_STARTED', runId: 'r' });
    aggregator.handle({ type: 'TEXT_MESSAGE_START', messageId: 'earlier' });
    aggregator.handle({
      type: 'TEXT_MESSAGE_CONTENT',
      messageId: 'earlier',
      delta: 'Earlier round',
    });
    const events: any[] = [];
    const projection = new DraftProjection('draft:r:1', (event) => {
      events.push(event);
      aggregator.handle(event as any);
    });
    expect(projection.publish(message([]) as any)).toBe(true);
    expect(events).toEqual([]);
    expect(
      projection.publish(message([{ type: 'thinking', thinking: 'Check the source.' }]) as any),
    ).toBe(true);
    const answer =
      kind === 'text'
        ? { type: 'text', text: 'The answer is still growing' }
        : { type: 'toolCall', id: 'ui', name: 'present_openui', arguments: { ui: 'root = Text(' } };
    expect(
      projection.publish(
        message([{ type: 'thinking', thinking: 'Check the source.' }, answer]) as any,
      ),
    ).toBe(true);
    expect(previous?.content).toEqual([{ type: 'text', text: 'Earlier round' }]);
    expect(events.slice(0, 3).map((event) => event.type)).toEqual([
      'REASONING_MESSAGE_START',
      'TEXT_MESSAGE_START',
      'REASONING_MESSAGE_CONTENT',
    ]);
    expect(latest.content?.map((part) => part.type)).toEqual([
      'reasoning',
      kind === 'text' ? 'text' : 'tool-call',
    ]);
    expect(events.filter((event) => event.type === 'TEXT_MESSAGE_START')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'REASONING_MESSAGE_END')).toHaveLength(1);
    if (kind === 'openui')
      expect(events.find((event) => event.type === 'TOOL_CALL_START')).toMatchObject({
        toolCallId: 'draft:r:1.ui',
        parentMessageId: 'draft:r:1',
      });
  },
);

it('keeps a late reasoning append on the same SDK part, preserves further text and tools, and commits once', () => {
  let latest: { content?: readonly ThreadAssistantMessagePart[] } = {};
  const aggregator = new RunAggregator({
    showThinking: true,
    logger: { debug() {}, error() {} },
    emit: (update) => (latest = update),
  });
  aggregator.handle({ type: 'RUN_STARTED', runId: 'r' });
  const events: any[] = [];
  const projection = new DraftProjection('draft:r:1', (event) => {
    events.push(event);
    aggregator.handle(event as any);
  });
  const draft = (thinking: string, text: string) =>
    message([
      { type: 'thinking', thinking },
      { type: 'text', text },
      { type: 'toolCall', id: 'read', name: 'read_web', arguments: { url: 'https://example.com' } },
    ]) as any;
  expect(projection.publish(draft('Think one.', 'Answer one.'))).toBe(true);
  expect(projection.publish(draft('Think one. Think two.', 'Answer one.'))).toBe(true);
  expect(projection.publish(draft('Think one. Think two.', 'Answer one. Answer two.'))).toBe(true);
  const final = draft('Think one. Think two.', 'Answer one. Answer two.');
  expect(projection.publish(final, true)).toBe(true);
  expect(latest.content?.filter((part) => part.type === 'reasoning')).toEqual([
    expect.objectContaining({ text: 'Think one. Think two.' }),
  ]);
  expect(latest.content?.find((part) => part.type === 'text')).toMatchObject({
    text: 'Answer one. Answer two.',
  });
  expect(latest.content?.filter((part) => part.type === 'tool-call')).toHaveLength(1);
  expect(events.filter((event) => event.type === 'TEXT_MESSAGE_START')).toHaveLength(1);
  expect(events.filter((event) => event.type === 'TOOL_CALL_START')).toHaveLength(1);
  const restored = fromAgUiMessages(
    toMessages([{ id: 2, model: [final] }] as any, new Map([['2', 'draft:r:1']])),
    {
      showThinking: true,
    },
  );
  expect(restored).toHaveLength(1);
  expect(restored[0].id).toBe('draft:r:1');
  expect(restored[0].content).toEqual(
    latest.content?.map((part) =>
      part.type === 'tool-call'
        ? Object.fromEntries(Object.entries(part).filter(([key]) => key !== 'parentId'))
        : part,
    ),
  );
  expect(projection.publish(draft('Replacement.', 'Answer one. Answer two.'))).toBe(false);
});
it.each([false, true])(
  'settles a real tool result through the native parser without losing isError=%s',
  (isError) => {
    let latest: { content?: readonly ThreadAssistantMessagePart[]; status?: { type: string } } = {};
    const aggregator = new RunAggregator({
      showThinking: true,
      logger: { debug() {}, error() {} },
      emit: (update) => (latest = update),
    });
    aggregator.handle({ type: 'RUN_STARTED', runId: 'r' });
    aggregator.handle({ type: 'TEXT_MESSAGE_START', messageId: 'draft:r:1' });
    aggregator.handle({
      type: 'TOOL_CALL_START',
      toolCallId: 'draft:r:1.read',
      toolCallName: 'read_web',
      parentMessageId: 'draft:r:1',
    });
    aggregator.handle({ type: 'TOOL_CALL_ARGS', toolCallId: 'draft:r:1.read', delta: '{}' });
    const content = isError ? 'Source could not be read' : '{"ready":true}';
    const result = toolResultEvent({
      id: '3',
      role: 'tool',
      toolCallId: 'draft:r:1.read',
      content,
      ...(isError ? { error: content } : {}),
    });
    const parsed = parseAgUiEvent(result);
    expect(parsed).not.toBeNull();
    aggregator.handle(parsed!);
    aggregator.handle({ type: 'RUN_FINISHED', runId: 'r' });
    expect(latest.status?.type).toBe('complete');
    const part = latest.content?.find((part) => part.type === 'tool-call');
    expect(part).toMatchObject({
      toolCallId: 'draft:r:1.read',
      unstable_toolMessageId: '3',
      isError,
    });
    if (isError)
      expect(part).toMatchObject({
        result: { isError: true, content: [{ type: 'text', text: content }] },
      });
    else expect(part).toMatchObject({ result: { ready: true } });
  },
);
it('folds Pi argument path slices without corrupting quotes, slashes or Unicode', () => {
  const fold = new StreamFold();
  fold.accept({
    type: 'message_start',
    message: message([
      { type: 'toolCall', id: 'a', name: 'present_openui', arguments: { ui: '' } },
    ]),
  });
  for (const delta of ['root = Text("text",', '"C:\\tmp ', '你好😀")'])
    fold.accept({
      type: 'message_update',
      usage,
      changes: [{ type: 'toolcall_delta', contentIndex: 0, path: ['ui'], delta }],
    });
  expect(fold.current?.content[0]).toMatchObject({
    arguments: { ui: 'root = Text("text","C:\\tmp 你好😀")' },
  });
  expect(openArgs({ ui: 'a"\\你好' })).toBe('{"ui":"a\\"\\\\你好');
});
it('replaces a block and whole draft, and rebuilds after snapshot without joining complete objects', () => {
  const fold = new StreamFold();
  fold.accept({
    type: 'message_start',
    message: message([
      { type: 'toolCall', id: 'a', name: 'present_openui', arguments: { ui: 'old' } },
    ]),
  });
  fold.accept({
    type: 'message_update',
    usage,
    changes: [
      {
        type: 'block',
        contentIndex: 0,
        block: { type: 'toolCall', id: 'a', name: 'present_openui', arguments: { ui: 'new' } },
      },
    ],
  });
  expect((fold.current!.content[0] as any).arguments.ui).toBe('new');
  fold.accept({
    type: 'message_update',
    usage,
    changes: [{ type: 'message', message: message([{ type: 'text', text: 'replacement' }]) }],
  });
  expect(fold.current!.content).toEqual([{ type: 'text', text: 'replacement' }]);
  fold.accept({
    type: 'snapshot',
    generation: { attempt: 1, message: message([{ type: 'text', text: 'seed' }]) },
  } as any);
  fold.accept({
    type: 'message_update',
    usage,
    changes: [{ type: 'text_delta', contentIndex: 0, delta: ' tail' }],
  });
  expect(fold.current!.content).toEqual([{ type: 'text', text: 'seed tail' }]);
});
it('uses stable Pi entries and scopes repeated call ids to the calling entry', () => {
  const entries = [
    { id: 2, model: [message([{ type: 'toolCall', id: 'same', name: 'x', arguments: {} }])] },
    {
      id: 3,
      model: [
        {
          role: 'toolResult',
          toolCallId: 'same',
          toolName: 'x',
          content: [{ type: 'text', text: 'ok' }],
        },
      ],
    },
    { id: 4, model: [message([{ type: 'toolCall', id: 'same', name: 'x', arguments: {} }])] },
  ] as any;
  const result = toMessages(entries);
  expect(result[0].id).toBe('2');
  expect((result[0] as any).toolCalls[0].id).toBe('2.same');
  expect((result[1] as any).toolCallId).toBe('2.same');
  expect((result[2] as any).toolCalls[0].id).toBe('4.same');
});
it('keeps streamed message, reasoning and tool identities when a draft commits, without merging real repeated calls', () => {
  const entries = [
    {
      id: 2,
      model: [
        message([
          { type: 'thinking', thinking: 'Check the source.' },
          { type: 'toolCall', id: 'same', name: 'x', arguments: {} },
        ]),
      ],
    },
    {
      id: 3,
      model: [
        {
          role: 'toolResult',
          toolCallId: 'same',
          isError: true,
          content: [{ type: 'text', text: 'Unavailable' }],
        },
      ],
    },
    { id: 4, model: [message([{ type: 'toolCall', id: 'same', name: 'x', arguments: {} }])] },
  ] as any;
  const projected = toMessages(
    entries,
    new Map([
      ['2', 'draft:r:1'],
      ['4', 'draft:r:2'],
    ]),
  );
  expect(projected[0].id).toBe('draft:r:1:reasoning:0');
  expect(projected[1]).toMatchObject({ id: 'draft:r:1', toolCalls: [{ id: 'draft:r:1.same' }] });
  expect(projected[2]).toMatchObject({ toolCallId: 'draft:r:1.same', error: 'Unavailable' });
  expect(projected[3]).toMatchObject({ id: 'draft:r:2', toolCalls: [{ id: 'draft:r:2.same' }] });
  expect(fromAgUiMessages(projected, { showThinking: true })).toHaveLength(2);
  // Aliases belong to this observation only; saved Pi identities remain authoritative.
  expect(toMessages(entries)[1].id).toBe('2');
});
it('keeps the current action context out of visible user history', () => {
  const source = { inputs: { $budget: '12.' } };
  const original = '请按我的选择继续\n保留这个换行';
  const entries = [
    {
      id: 9,
      model: [
        {
          role: 'user',
          content: [
            { type: 'text', text: original + USER_ACTION_CONTEXT + '\n' + JSON.stringify(source) },
          ],
        },
      ],
    },
  ] as any;
  expect(toMessages(entries)).toEqual([{ id: '9', role: 'user', content: original }]);
});

it('restores model reasoning into the same stable assistant entry without exposing opaque metadata', () => {
  const entries = [
    {
      id: 12,
      model: [
        message([
          {
            type: 'thinking',
            thinking: 'Compare the available sources.',
            thinkingSignature: 'provider-private',
          },
          {
            type: 'thinking',
            thinking: 'encrypted-private',
            redacted: true,
            thinkingSignature: 'encrypted-signature',
          },
          { type: 'thinking', thinking: '' },
          { type: 'thinking', thinking: 'Second reasoning block.' },
          { type: 'text', text: 'Here is the comparison.' },
          {
            type: 'toolCall',
            id: 'read',
            name: 'read_web',
            arguments: { url: 'https://example.com' },
          },
        ]),
      ],
    },
  ] as any;
  const history = toMessages(entries);
  expect(history[0]).toEqual({
    id: '12:reasoning:0',
    role: 'reasoning',
    content: 'Compare the available sources.',
  });
  expect(JSON.stringify(history)).not.toMatch(
    /provider-private|encrypted-private|encrypted-signature/,
  );
  entries[0].edits = [{ action: 'replace', target: 11, messages: entries[0].model }];
  const projection = browserEntries(entries);
  expect(JSON.stringify(projection)).not.toMatch(
    /provider-private|encrypted-private|encrypted-signature/,
  );
  expect(JSON.stringify(entries)).toContain('encrypted-signature');
  expect(toMessages(projection)).toEqual(history);
  const restored = fromAgUiMessages(history, { showThinking: true });
  expect(restored).toHaveLength(1);
  expect(restored[0].id).toBe('12');
  expect(restored[0].content[0]).toMatchObject({
    type: 'reasoning',
    text: 'Compare the available sources.',
  });
  expect(restored[0].content.at(-1)).toMatchObject({ type: 'tool-call', toolCallId: '12.read' });
});
