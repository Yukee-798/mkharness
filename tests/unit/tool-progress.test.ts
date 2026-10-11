import { expect, it } from 'vitest';
import { ToolProgressFold, projectToolProgress } from '../../src/shared/tool-progress';
import { browserEntries } from '../../src/shared/stream';
const assistant = (id: number) =>
  ({
    id,
    model: [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'same', name: 'probe', arguments: {} }],
      },
    ],
  }) as any;
const projector = ({ output, details }: any) => ({
  output: output ?? '',
  details: details ?? null,
});
it('applies native output windows and replacement details, preserves terminal status and distinguishes rounds', () => {
  const fold = new ToolProgressFold();
  fold.round(assistant(2));
  fold.update('2.same', { output: { set: 'abc' }, details: { first: true } });
  fold.update('2.same', { output: { append: 'def' } });
  fold.update('2.same', { output: { trimStart: 3, append: 'gh' }, details: { last: true } });
  expect(fold.project(() => projector)['2.same']).toMatchObject({
    status: 'running',
    value: { output: 'defgh', details: { last: true } },
  });
  fold.end('2.same', false);
  fold.round(assistant(5));
  fold.update('2.same', { output: { append: 'late' } });
  expect(fold.project(() => projector)['2.same']).toEqual({ status: 'failed' });
  expect(fold.project(() => projector)['5.same']).toEqual({
    status: 'pending',
    value: { output: '', details: null },
  });
  fold.end('5.same', true);
  fold.update('5.same', { details: { late: true } });
  expect(fold.project(() => projector)['5.same']).toEqual({ status: 'complete' });
});
it('restores snapshots, requires exact native round identity, and bounds only explicitly public values', () => {
  const entries = [assistant(2), assistant(5)];
  const fold = new ToolProgressFold();
  expect(
    fold.restore(
      entries,
      [
        {
          callId: 'same',
          name: 'probe',
          status: 'running',
          output: 'restored',
          details: { private: 'secret' },
        },
      ] as any,
      5,
    ),
  ).toBe(true);
  expect(fold.project(() => undefined)['5.same']).toEqual({ status: 'running' });
  expect(JSON.stringify(fold.project(() => () => ({ public: 'x'.repeat(17000) })))).not.toContain(
    'secret',
  );
  expect(fold.project(() => () => ({ public: 'x'.repeat(17000) }))['5.same']).toMatchObject({
    truncated: true,
  });
  expect(
    new ToolProgressFold().restore(
      entries,
      [{ callId: 'missing', name: 'probe', status: 'running' }] as any,
      5,
    ),
  ).toBe(false);
  expect(projectToolProgress(fold, () => projector)['5.same']).toMatchObject({
    status: 'running',
    value: { output: 'restored' },
  });
});
it('does not publicly expose native details, diagnostics or entry data through REST history', () => {
  const entries = [
    {
      id: 3,
      kind: 'pi.toolResult',
      data: { diagnostics: ['private'] },
      model: [
        {
          role: 'toolResult',
          toolCallId: 'same',
          toolName: 'probe',
          content: [{ type: 'text', text: 'result' }],
          details: { secret: 'secret' },
          timestamp: 0,
          isError: false,
        },
      ],
    },
  ] as any;
  const publicHistory = browserEntries(entries);
  expect(JSON.stringify(publicHistory)).not.toMatch(/private|secret|details|diagnostics/);
  expect((publicHistory as any)[0].model[0].content[0].text).toBe('result');
  expect(entries[0].data.diagnostics).toEqual(['private']);
});
