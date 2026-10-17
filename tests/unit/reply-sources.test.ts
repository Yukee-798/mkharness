import { expect, it } from 'vitest';
import { projectSources } from '../../src/extensions/web/sources';
import { replyContribution } from '../../src/extensions/reply/server';
import { extensionIds, exampleDefinition } from '../../src/extensions/server';
import { USER_ACTION_CONTEXT } from '../../src/shared/contracts';
import type { ReadContext } from '../../src/server/extensions/contributions';

const result = (id: number, toolName: string, value: unknown, isError = false) => ({
  id,
  model: [
    {
      role: 'toolResult',
      toolName,
      toolCallId: 'reused',
      isError,
      content: [{ type: 'text', text: JSON.stringify(value) }],
    },
  ],
});
it('projects deduplicated safe successful sources per completed reply without exposing raw details', () => {
  const entries = [
    { id: 1 },
    result(2, 'read_web', {
      url: 'https://example.com/a#part',
      title: 'A',
      text: 'x'.repeat(900),
      private: 'secret',
    }),
    result(3, 'search_web', {
      results: [
        { url: 'https://example.com/a', title: 'duplicate' },
        { url: 'javascript:alert(1)', title: 'unsafe' },
        { url: 'https://secret@example.com/', title: 'credentials' },
        { url: 'https://example.com/b', title: 'B', content: 'Snippet' },
      ],
    }),
    result(4, 'read_web', { url: 'https://failed.example.com/' }, true),
    { id: 5 },
    { id: 6 },
    result(7, 'read_web', { url: 'https://next.example.com/' }),
    { id: 8 },
  ];
  const input = {
    entries,
    tasks: [],
    submissions: [
      { type: 'input', status: 'done', entry: 1, answer: 5 },
      { type: 'input', status: 'done', entry: 6, answer: 8 },
      { type: 'input', status: 'placed', entry: 6, answer: 7 },
    ],
  } as any;
  const projected = projectSources(input);
  expect(projected.replies['5']).toEqual([
    { url: 'https://example.com/a', title: 'A', snippet: 'x'.repeat(280) },
    { url: 'https://example.com/b', title: 'B', snippet: 'Snippet' },
  ]);
  expect(projected.replies['8']).toEqual([
    { url: 'https://next.example.com/', title: 'next.example.com' },
  ]);
  expect(JSON.stringify(projected)).not.toContain('secret');
  expect(projected.replies['7']).toBeUndefined();
  expect(projectSources(structuredClone(input))).toEqual(projected);
});
it('bounds large source lists and ignores malformed and non-web tool outputs', () => {
  const entries = [
    { id: 1 },
    result(2, 'search_web', {
      results: Array.from({ length: 30 }, (_, i) => ({ url: `https://example.com/${i}` })),
    }),
    result(3, 'other_tool', { url: 'https://unrelated.example.com/' }),
    { id: 4 },
  ];
  expect(
    projectSources({
      entries,
      tasks: [],
      submissions: [{ type: 'input', status: 'done', entry: 1, answer: 4 }],
    } as any).replies['4'],
  ).toHaveLength(20);
});
it('regeneration reads only the referenced chat input and freezes its original action context as data', async () => {
  const original = 'Analyze my selection' + USER_ACTION_CONTEXT + '\n{"state":{"amount":40}}';
  const normalize = replyContribution().actions!.regenerate!.normalize;
  const context: ReadContext = {
    nativeConversationId: 42,
    entries: async () => {
      throw new Error('active context is not historical action lookup');
    },
    successfulTool: async () => undefined,
    acceptedInput: async () => {
      throw new Error('input visibility alone does not authorize an answer');
    },
    acceptedInputForAnswer: async (id: number) =>
      id === 2 ? { text: original, context: { state: { amount: 40 } } } : undefined,
  };
  expect(await normalize({ entryId: '2' }, context)).toEqual({
    action: 'regenerate',
    originalRequest: { text: original, context: { state: { amount: 40 } } },
  });
  await expect(normalize({ entryId: '999' }, context)).rejects.toMatchObject({
    code: 'reply_not_found',
  });
  await expect(normalize({ entryId: '1' }, context)).rejects.toMatchObject({
    code: 'reply_not_found',
  });
  await expect(normalize({ entryId: '../2' }, context)).rejects.toMatchObject({
    code: 'invalid_action_payload',
  });
});
it('repeated regeneration inherits the first frozen input without nesting or new authority', async () => {
  const original = { text: 'First question', context: { selected: 'A' } };
  const context: ReadContext = {
    nativeConversationId: 42,
    entries: async () => {
      throw new Error('active context is not historical action lookup');
    },
    successfulTool: async () => undefined,
    acceptedInput: async () => {
      throw new Error('input visibility alone does not authorize an answer');
    },
    acceptedInputForAnswer: async () => ({
      text: 'Regenerate response',
      source: { action: 'extension_action', extensionId: 'reply', name: 'regenerate', payload: {} },
      context: { action: 'regenerate', originalRequest: original },
    }),
  };
  expect(
    await replyContribution().actions!.regenerate!.normalize(
      { entryId: '2', action: 'retry_remote' },
      context,
    ),
  ).toEqual({ action: 'regenerate', originalRequest: original });
});
it('the sample remains available to opt in, but is absent from default capabilities', async () => {
  expect(extensionIds()).not.toContain('example');
  expect(extensionIds()).toContain('reply');
  expect(
    (
      await exampleDefinition.create({ env: {} as Env, entries: async () => [] })
    ).extension?.tools?.map((t) => t.name),
  ).toContain('describe_text');
});
