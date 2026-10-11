import { expect, it, vi } from 'vitest';
import { createResourceDrafts } from '../../src/browser/draft';
it('isolates users, chats, extensions and refs and cleans only the selected chat', async () => {
  vi.useFakeTimers();
  const drafts = createResourceDrafts(),
    save = vi.fn(async (_state, revision: number) => revision + 1);
  const scopes = [
    ['alice', 'chat', 'a', 'ref'],
    ['bob', 'chat', 'a', 'ref'],
    ['alice', 'chat2', 'a', 'ref'],
    ['alice', 'chat', 'b', 'ref'],
  ] as const;
  const opened = scopes.map((scope) => drafts.open(scope, {}, 0, save));
  opened.forEach((draft) => draft.saver.update({ value: 'edit' }));
  drafts.removeConversation('chat', 'alice');
  expect(drafts.open(scopes[1], {}, 0, save)).toBe(opened[1]);
  await vi.advanceTimersByTimeAsync(500);
  expect(save).toHaveBeenCalledTimes(2);
  expect(drafts.open(scopes[0], { value: 'fresh' }, 0, save).saver.current()).toEqual({
    value: 'fresh',
  });
  drafts.dispose();
  vi.useRealTimers();
});
