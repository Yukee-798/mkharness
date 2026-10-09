import { it, expect } from 'vitest';
import { StreamFold, openArgs, toMessages } from '../../src/shared/stream';
import { usage } from '../fixture-model';
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
