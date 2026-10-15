import { expect, it } from 'vitest';
import {
  projectSuggestions,
  suggestionsSchema,
  SUGGESTIONS_TOOL,
} from '../../src/extensions/reply/suggestions';
import { replyContribution } from '../../src/extensions/reply/server';
import type { ProjectionContext } from '../../src/server/contributions';
import { checkRunLimits } from '../../src/server/limits';
import { toolkit, activity } from '../../src/extensions/reply/browser';
import { loadBrowserExtensions } from '../../src/browser/extensions';

const answer = (id: number, prompts: string[]) => ({
  id,
  model: [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'An answer about the current subject' },
        { type: 'toolCall', id: 'reused', name: SUGGESTIONS_TOOL, arguments: { prompts } },
      ],
    },
  ],
});
const result = (id: number, task: number, prompts: unknown, isError = false) => ({
  id,
  byTaskId: task,
  model: [
    {
      role: 'toolResult',
      toolName: SUGGESTIONS_TOOL,
      toolCallId: 'reused',
      isError,
      content: [{ type: 'text', text: JSON.stringify({ prompts }) }],
    },
  ],
});
const task = (id: number, assistant: number) => ({
  id,
  kind: 'pi.tool',
  input: { kind: 'model', assistant, callId: 'reused' },
});
const done = (entry: number, end: number) => ({
  type: 'input',
  status: 'done',
  entry,
  answer: end,
});

it('projects only successful metadata bound to the exact completed answer and native task identity', () => {
  const input = {
    entries: [
      { id: 1 },
      answer(2, ['Compare cache invalidation options']),
      result(3, 20, ['Compare cache invalidation options']),
      { id: 4 },
      answer(5, ['解释数据库锁的范围']),
      result(6, 21, ['解释数据库锁的范围']),
      result(7, 20, ['Wrong old result']),
      { id: 8 },
      answer(9, ['Pending']),
      result(10, 22, ['Pending']),
    ],
    tasks: [task(20, 2), task(21, 5), task(22, 9)],
    submissions: [done(1, 2), done(4, 5), { type: 'input', status: 'placed', entry: 8 }],
  } as unknown as ProjectionContext;
  // Ambiguous duplicate old results are discarded and cannot affect the next answer.
  expect(projectSuggestions(input).replies['2']).toBeUndefined();
  expect(projectSuggestions(input).replies['5']).toEqual(['解释数据库锁的范围']);
  expect(projectSuggestions(input).replies['9']).toBeUndefined();
  expect(projectSuggestions(structuredClone(input))).toEqual(projectSuggestions(input));
});

it('drops failed, invalid, missing and superseded metadata without generic fallback suggestions', () => {
  const input = {
    entries: [
      { id: 1 },
      answer(2, ['Earlier']),
      result(3, 20, ['Earlier']),
      {
        id: 4,
        model: [{ role: 'assistant', content: [{ type: 'text', text: 'Repaired answer' }] }],
      },
      { id: 5 },
      answer(6, ['Failed']),
      result(7, 21, ['Failed'], true),
      { id: 8 },
      answer(9, ['Invalid']),
      result(10, 22, ['x'.repeat(161)]),
      { id: 11 },
      answer(12, []),
      result(13, 23, []),
    ],
    tasks: [task(20, 2), task(21, 6), task(22, 9), task(23, 12)],
    submissions: [done(1, 4), done(5, 6), done(8, 9), done(11, 12)],
  } as unknown as ProjectionContext;
  expect(projectSuggestions(input)).toEqual({ replies: {} });
});

it('validates bounded distinct user-language prompts and rejects control characters and extra data', () => {
  expect(
    suggestionsSchema.parse({
      prompts: ['  如何选择索引？ ', '如何选择索引？', 'Compare B-tree and hash indexes'],
    }),
  ).toEqual({ prompts: ['如何选择索引？', 'Compare B-tree and hash indexes'] });
  for (const value of [
    { prompts: [''] },
    { prompts: ['x'.repeat(161)] },
    { prompts: ['a', 'b', 'c', 'd'] },
    { prompts: ['unsafe\nrequest'] },
    { prompts: ['a'], private: 'hidden' },
    { prompts: [5] },
  ])
    expect(suggestionsSchema.safeParse(value).success).toBe(false);
});

it('installs suggestions as an optional native local tool without a writable result store', () => {
  const contribution = replyContribution();
  expect(contribution.extension?.tools?.map((tool) => tool.name)).toEqual([SUGGESTIONS_TOOL]);
  expect(contribution.extension?.tools?.[0]).toMatchObject({ replay: 'safe', callers: ['model'] });
  expect(contribution.projectState).toBe(projectSuggestions);
  expect(contribution.resources).toBeUndefined();
});

it('uses the host hidden-tool metadata and the ordinary tool budget', async () => {
  const loaded = await loadBrowserExtensions(['reply'], {
    reply: async () => ({ toolkit, activity }),
  });
  expect(loaded.unavailable).toEqual([]);
  expect(activity[SUGGESTIONS_TOOL]).toBe('hidden');
  expect(toolkit[SUGGESTIONS_TOOL].render()).toBeNull();
  expect(() =>
    checkRunLimits(
      [{ id: 1, kind: 'pi.user' }, answer(2, ['Continue']), result(3, 20, ['Continue'])] as any,
      1,
    ),
  ).toThrow('Tool call limit reached (1)');
});
