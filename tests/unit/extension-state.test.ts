import { expect, it, vi } from 'vitest';
import { createExtensionProjection } from '../../src/server/extension-state';
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';

it('removing public projections removes their reads and listeners too', async () => {
  const pi = { commit: vi.fn(), subscribeCommits: vi.fn() };
  const projection = createExtensionProjection(pi as any, [], [], {} as any);
  await projection.restore();
  expect(projection.project()).toEqual({});
  expect(
    projection.accept([
      { type: 'entry', value: { id: 2, conversationId: ROOT_CONVERSATION_ID } },
    ] as any),
  ).toBe(false);
  expect(pi.commit).not.toHaveBeenCalled();
  expect(pi.subscribeCommits).not.toHaveBeenCalled();
});
it('folds atomic native changes without publishing private or unchanged metadata', () => {
  const projectState = vi.fn(({ tasks }) => ({
    finished: tasks
      .filter((task: any) => task.state.status === 'terminal')
      .map((task: any) => Number(task.id)),
  }));
  const projection = createExtensionProjection(
    {} as any,
    [{ id: 'generic', projectState }],
    [],
    {} as any,
  );
  expect(projection.project()).toEqual({ generic: { finished: [] } });
  expect(
    projection.accept([
      { type: 'task', value: { id: 8, conversationId: 999, state: { status: 'terminal' } } },
    ] as any),
  ).toBe(false);
  expect(projection.hasChanges()).toBe(false);
  expect(projectState).toHaveBeenCalledTimes(1);
  projection.accept([
    {
      type: 'task',
      value: {
        id: 8,
        conversationId: ROOT_CONVERSATION_ID,
        state: { status: 'running' },
        details: 'Private',
      },
    },
  ] as any);
  expect(projection.hasChanges()).toBe(false);
  expect(projectState).toHaveBeenCalledTimes(2);
  projection.accept([
    {
      type: 'task',
      value: {
        id: 8,
        conversationId: ROOT_CONVERSATION_ID,
        state: { status: 'terminal' },
        details: 'Private',
      },
    },
  ] as any);
  expect(projection.hasChanges()).toBe(true);
  expect(projection.project()).toEqual({ generic: { finished: [8] } });
  expect(projection.hasChanges()).toBe(false);
  expect(projectState).toHaveBeenCalledTimes(3);
});
