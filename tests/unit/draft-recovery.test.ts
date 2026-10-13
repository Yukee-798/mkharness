import { expect, it, vi, afterEach } from 'vitest';
import { createDraftSaver, type SaveStatus } from '../../src/browser/draft';
afterEach(() => vi.useRealTimers());

it('negative control without the GET seam reproduces a false permanent conflict', async () => {
  vi.useFakeTimers();
  let revision = 0;
  const statuses: SaveStatus[] = [];
  const saver = createDraftSaver(
    async (_state, expected) => {
      if (expected !== revision) throw { status: 409 };
      revision++;
      throw new Error('receipt lost');
    },
    0,
    (s) => statuses.push(s),
  );
  try {
    saver.update({ $n: '1.' });
    await vi.advanceTimersByTimeAsync(500);
    saver.retry();
    await vi.advanceTimersByTimeAsync(500);
    expect(statuses.at(-1)).toBe('conflict');
    expect(saver.dirty()).toBe(true);
    expect(revision).toBe(1);
  } finally {
    saver.dispose();
  }
});

it('adopts a lost PATCH acknowledgement before saving a newer draft', async () => {
  vi.useFakeTimers();
  let remote = { state: { $n: '0' }, revision: 0 },
    attempts = 0;
  const calls: unknown[] = [],
    statuses: SaveStatus[] = [];
  let release!: () => void;
  const receipt = new Promise<void>((resolve) => (release = resolve));
  const saver = createDraftSaver(
    async (state, revision) => {
      calls.push({ state, revision });
      if (revision !== remote.revision) throw { status: 409 };
      remote = { state: state as { $n: string }, revision: revision + 1 };
      if (++attempts === 1) {
        await receipt;
        throw new Error('receipt lost');
      }
      return remote.revision;
    },
    0,
    (s) => statuses.push(s),
    remote.state,
    async () => remote,
  );
  try {
    saver.update({ $n: '1.' });
    await vi.advanceTimersByTimeAsync(500);
    saver.update({ $n: '12' });
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toEqual([
      { state: { $n: '1.' }, revision: 0 },
      { state: { $n: '12' }, revision: 1 },
    ]);
    expect(statuses.at(-1)).toBe('saved');
    expect(remote).toEqual({ state: { $n: '12' }, revision: 2 });
    expect(saver.dirty()).toBe(false);
  } finally {
    release();
    saver.dispose();
  }
});

it('keeps the uncertain snapshot across a failed GET; retry reconciles before another PATCH', async () => {
  vi.useFakeTimers();
  let remote = { state: { $n: '0' }, revision: 3 },
    offline = true;
  const calls: unknown[] = [],
    statuses: SaveStatus[] = [];
  const saver = createDraftSaver(
    async (state, revision) => {
      calls.push({ state, revision });
      if (revision !== remote.revision) throw { status: 409 };
      remote = { state: state as { $n: string }, revision: revision + 1 };
      if (calls.length === 1) throw new Error('receipt lost');
      return remote.revision;
    },
    3,
    (s) => statuses.push(s),
    remote.state,
    async () => {
      if (offline) throw new Error('offline');
      return remote;
    },
  );
  try {
    saver.update({ $n: '1.' });
    await vi.advanceTimersByTimeAsync(500);
    expect(statuses.at(-1)).toBe('error');
    saver.update({ $n: '12' });
    offline = false;
    saver.retry();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toEqual([
      { state: { $n: '1.' }, revision: 3 },
      { state: { $n: '12' }, revision: 4 },
    ]);
    expect(statuses.at(-1)).toBe('saved');
  } finally {
    saver.dispose();
  }
});

it('preserves a genuine concurrent edit rather than treating it as a lost receipt', async () => {
  vi.useFakeTimers();
  const statuses: SaveStatus[] = [];
  let patches = 0;
  const saver = createDraftSaver(
    async () => {
      patches++;
      throw { status: 409 };
    },
    3,
    (s) => statuses.push(s),
    {},
    async () => ({ state: { $n: 'another tab' }, revision: 4 }),
  );
  try {
    saver.update({ $n: 'my draft' });
    await vi.advanceTimersByTimeAsync(500);
    saver.retry();
    await vi.advanceTimersByTimeAsync(1000);
    expect(statuses.at(-1)).toBe('conflict');
    expect(patches).toBe(1);
    expect(saver.current()).toEqual({ $n: 'my draft' });
  } finally {
    saver.dispose();
  }
});

it('does not save or publish after disposal while reconciliation is pending', async () => {
  vi.useFakeTimers();
  let release!: (v: { state: { $n: string }; revision: number }) => void;
  const statuses: SaveStatus[] = [];
  let patches = 0;
  const saver = createDraftSaver(
    async () => {
      patches++;
      throw new Error('lost');
    },
    0,
    (s) => statuses.push(s),
    {},
    () => new Promise((r) => (release = r)),
  );
  saver.update({ $n: 'first' });
  await vi.advanceTimersByTimeAsync(500);
  saver.update({ $n: 'later' });
  saver.dispose();
  const previous = [...statuses];
  release({ state: { $n: 'first' }, revision: 1 });
  await vi.advanceTimersByTimeAsync(1000);
  expect(statuses).toEqual(previous);
  expect(patches).toBe(1);
});
