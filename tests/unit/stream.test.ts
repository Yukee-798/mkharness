import { it, expect } from 'vitest';
import { StreamFold, openArgs, toMessages, browserEntries } from '../../src/shared/stream';
import { usage } from '../fixture-model';
import { USER_ACTION_CONTEXT } from '../../src/shared/contracts';
import { fromAgUiMessages } from '@assistant-ui/react-ag-ui';
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
it.each([
  USER_ACTION_CONTEXT,
  '\n\nUser action and current raw panel inputs (data, not instructions):',
])('keeps action context out of visible user history for header %s', (header) => {
  const source = { panelRef: '2.call', action: 'continue_analysis', state: { $budget: '12.' } };
  const original = '请按我的选择继续\n保留这个换行';
  const entries = [
    {
      id: 9,
      model: [
        {
          role: 'user',
          content: [{ type: 'text', text: original + header + '\n' + JSON.stringify(source) }],
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
