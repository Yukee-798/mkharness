import { expect, it } from 'vitest';
import { projectTiming } from '../../src/extensions/timing/server';
import { formatDuration } from '../../src/extensions/timing/contracts';
import { loadBrowserExtensions } from '../../src/browser/extensions';

it('uses canonical native receipts, excludes queue time and never sums parallel tool spans', () => {
  const entries = [
    { id: 1, model: [{ role: 'user', timestamp: 100 }] },
    {
      id: 2,
      model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'same', name: 'x' }] }],
    },
    {
      id: 4,
      model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'same', name: 'x' }] }],
    },
    {
      id: 6,
      byTaskId: 30,
      model: [{ role: 'assistant', content: [{ type: 'text', text: 'answer' }] }],
    },
  ];
  const tasks = [
    {
      id: 10,
      kind: 'pi.tool',
      input: { kind: 'model', assistant: 2, callId: 'same' },
      startedAt: 110,
      endedAt: 180,
      state: { status: 'terminal' },
    },
    {
      id: 20,
      kind: 'pi.tool',
      input: { kind: 'model', assistant: 4, callId: 'same' },
      startedAt: 115,
      endedAt: 190,
      state: { status: 'terminal' },
    },
    { id: 30, kind: 'pi.generation', startedAt: 195, endedAt: 200, state: { status: 'terminal' } },
    {
      id: 40,
      kind: 'pi.tool',
      input: { kind: 'model', assistant: 999, callId: 'same' },
      startedAt: 105,
      endedAt: 195,
      state: { status: 'terminal' },
    },
  ];
  const state = projectTiming({
    entries,
    tasks,
    submissions: [
      { type: 'input', status: 'done', requestId: 'r', entry: 1, answer: 6 },
      { type: 'input', status: 'queued', requestId: 'queued' },
    ],
  } as any);
  expect(state.tools).toEqual({
    '2.same': { startedAt: 110, endedAt: 180 },
    '4.same': { startedAt: 115, endedAt: 190 },
  });
  expect(state.replies).toEqual({ '6': { runId: 'r', startedAt: 100, endedAt: 200 } });
  expect(formatDuration(842)).toBe('842 ms');
  expect(formatDuration(12400)).toBe('12.4 s');
});

it('does not invent completion or duration without native timestamps', () => {
  const state = projectTiming({
    entries: [
      {
        id: 2,
        model: [
          {
            role: 'assistant',
            content: [
              { type: 'toolCall', id: 'a' },
              { type: 'toolCall', id: 'b' },
            ],
          },
        ],
      },
    ],
    tasks: [
      {
        id: 1,
        kind: 'pi.tool',
        input: { kind: 'model', assistant: 2, callId: 'a' },
        state: { status: 'terminal' },
      },
      {
        id: 2,
        kind: 'pi.tool',
        input: { kind: 'model', assistant: 2, callId: 'b' },
        startedAt: 100,
        state: { status: 'waiting' },
      },
    ],
    submissions: [],
  } as any);
  expect(state).toEqual({ tools: { '2.b': { startedAt: 100 } }, replies: {} });
});

it('a presentation-only extension loads without registering model tools', async () => {
  const ui = { toolTitleMeta: () => null, assistantFooter: () => null };
  const loaded = await loadBrowserExtensions(['timing'], { timing: async () => ({ ui }) });
  expect(loaded).toEqual({ modules: [{ id: 'timing', ui }], unavailable: [] });
});
