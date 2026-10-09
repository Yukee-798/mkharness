import { it, expect, vi } from 'vitest';
import { createDraftSaver, type SaveStatus } from '../../src/browser/draft';
it('serializes saves, coalesces edits and uses acknowledged revisions without replacing raw drafts', async () => {
  vi.useFakeTimers();
  const calls: { state: unknown; revision: number }[] = [];
  let finish: (n: number) => void = () => {};
  const saver = createDraftSaver(
    async (state, revision) => {
      calls.push({ state, revision });
      return new Promise<number>((r) => (finish = r));
    },
    0,
    () => {},
  );
  saver.update({ $n: '' });
  await vi.advanceTimersByTimeAsync(500);
  expect(calls).toEqual([{ state: { $n: '' }, revision: 0 }]);
  saver.update({ $n: '1.' });
  await vi.advanceTimersByTimeAsync(1000);
  expect(calls).toHaveLength(1);
  finish(1);
  await vi.advanceTimersByTimeAsync(500);
  expect(calls[1]).toEqual({ state: { $n: '1.' }, revision: 1 });
  expect(saver.current()).toEqual({ $n: '1.' });
  saver.dispose();
  vi.useRealTimers();
});
it('retains a conflict draft and never blindly retries or overwrites it', async () => {
  vi.useFakeTimers();
  const states: SaveStatus[] = [];
  let attempts = 0;
  const saver = createDraftSaver(
    async () => {
      attempts++;
      throw { status: 409 };
    },
    3,
    (status) => states.push(status),
  );
  saver.update({ $n: '' });
  await vi.advanceTimersByTimeAsync(500);
  expect(states.at(-1)).toBe('conflict');
  saver.update({ $n: '12' });
  saver.retry();
  await vi.advanceTimersByTimeAsync(2000);
  expect(attempts).toBe(1);
  expect(states.at(-1)).toBe('conflict');
  expect(saver.current()).toEqual({ $n: '12' });
  saver.dispose();
  vi.useRealTimers();
});

it('retries a transient save using the current draft and last acknowledged revision', async () => {
  vi.useFakeTimers();
  let attempts = 0;
  const calls: unknown[] = [];
  const saver = createDraftSaver(
    async (state, revision) => {
      calls.push({ state, revision });
      if (++attempts === 1) throw new Error('offline');
      return revision + 1;
    },
    2,
    () => {},
  );
  saver.update({ $n: '1.' });
  await vi.advanceTimersByTimeAsync(500);
  saver.update({ $n: '12' });
  saver.retry();
  await vi.advanceTimersByTimeAsync(500);
  expect(calls).toEqual([
    { state: { $n: '1.' }, revision: 2 },
    { state: { $n: '12' }, revision: 2 },
  ]);
  saver.dispose();
  vi.useRealTimers();
});
