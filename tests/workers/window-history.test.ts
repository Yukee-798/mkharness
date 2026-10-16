import { env, runInDurableObject } from 'cloudflare:test';
import { UserEntry, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import { it, expect, vi } from 'vitest';
import { BG } from '../../src/server/conversations/context';

it.each([1000, 10000])(
  'reads only the latest history window after indexing (%s entries)',
  async (size) => {
    const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
    const measurement = await runInDurableObject(stub, async (instance, state) => {
      const root = await instance.root();
      await root.commit(async (tx) => {
        for (let n = 0; n < size; n++)
          await tx.appendEntry(UserEntry, root.id, {
            model: [{ role: 'user', content: 'message ' + n, timestamp: n }],
          });
      }, BG);
      await expect
        .poll(async () => JSON.parse(await instance.snapshot(undefined, true)).history)
        .toBeDefined();
      const sql = vi.spyOn(state.storage.sql, 'exec');
      try {
        const latest = JSON.parse(await instance.snapshot(undefined, true));
        expect(latest.entries).toHaveLength(100);
        expect(latest.entries.at(-1).model[0].content).toBe('message ' + (size - 1));
        const rows = sql.mock.calls.reduce(
          (sum, [query], i) =>
            sum +
            (/\b(?:FROM|JOIN)\s+"?pi_entries\b/i.test(query) &&
            sql.mock.results[i]?.type === 'return'
              ? Number(sql.mock.results[i].value.rowsRead)
              : 0),
          0,
        );
        expect(rows).toBeLessThanOrEqual(220);
        const upper = latest.history.upperEntryId;
        await root.commit(
          (tx) =>
            tx.appendEntry(UserEntry, ROOT_CONVERSATION_ID, {
              model: [{ role: 'user', content: 'new message', timestamp: size }],
            }),
          BG,
        );
        const older = JSON.parse(await instance.readHistory(latest.history.olderCursor));
        expect(older.entries).toHaveLength(100);
        expect(older.history.upperEntryId).toBe(upper);
        expect(Number(older.entries.at(-1).id)).toBeLessThan(Number(latest.entries[0].id));
        expect(older.entries.some((entry: any) => entry.model[0].content === 'new message')).toBe(
          false,
        );
        return { size, rows, returned: latest.entries.length };
      } finally {
        sql.mockRestore();
      }
    });
    console.log('WINDOW_READS', JSON.stringify(measurement));
  },
  30000,
);

it('rejects an invalid history cursor without failing the native session', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  expect(JSON.parse(await stub.readHistory('{"v":1,"before":-1,"upper":10}'))).toMatchObject({
    error: { status: 400, code: 'invalid_cursor' },
  });
  await expect(stub.readHistory()).resolves.toBeTypeOf('string');
});

it('extends a page starting at a final tool result through its answer and original input', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const runId = crypto.randomUUID();
  await stub.submitRun({ runId, text: 'panel' });
  await (await stub.observeRun(runId)).text();
  const original = JSON.parse(await stub.snapshot());
  expect(original.entries.at(-1).model[0].role).toBe('toolResult');
  await runInDurableObject(stub, async (instance) => {
    const root = await instance.root();
    await root.commit(async (tx) => {
      for (let n = 0; n < 99; n++)
        await tx.appendEntry(UserEntry, root.id, {
          model: [{ role: 'user', content: 'padding ' + n, timestamp: n }],
        });
    }, BG);
  });
  const latest = JSON.parse(await stub.snapshot(undefined, true));
  expect(latest.entries[0].id).toBe(original.entries[0].id);
  const replies = Object.assign(
    {},
    ...Object.values(latest.history.annotations).map((value: any) => value.timing?.replies),
  );
  expect(replies).toEqual(original.extensionState.timing.replies);
});

it('restores historical timing and tool progress on older pages after index backfill resumes', async () => {
  const { openPiSessionStore } = await import('agents/harness/pi');
  const { ConversationFactsIndex } = await import('../../src/server/conversations/facts-index');
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const runId = crypto.randomUUID();
  await stub.submitRun({ runId, text: 'progress seam' });
  await (await stub.observeRun(runId)).text();
  const legacy = JSON.parse(await stub.snapshot());
  await runInDurableObject(stub, async (instance, state) => {
    const native = await openPiSessionStore(state.storage);
    state.storage.sql.exec("DELETE FROM app_meta WHERE key LIKE 'read-index-v1%'");
    const scan = vi
      .spyOn(native, 'scanSubmissions')
      .mockRejectedValueOnce(new Error('interrupted backfill'));
    const failed = new ConversationFactsIndex(state.storage);
    await expect(failed.prepare(native)).rejects.toThrow('interrupted backfill');
    expect(failed.ready).toBe(false);
    scan.mockRestore();
    const tasks = vi.spyOn(native, 'scanTasks');
    const resumed = new ConversationFactsIndex(state.storage);
    await resumed.prepare(native);
    expect(resumed.ready).toBe(true);
    expect(tasks).not.toHaveBeenCalled();
    tasks.mockRestore();
    const root = await instance.root();
    await root.commit(async (tx) => {
      for (let n = 0; n < 250; n++)
        await tx.appendEntry(UserEntry, root.id, {
          model: [{ role: 'user', content: 'later ' + n, timestamp: n }],
        });
    }, BG);
  });
  const latest = JSON.parse(await stub.snapshot(undefined, true));
  let page = latest;
  while (page.history.olderCursor)
    page = JSON.parse(await stub.readHistory(page.history.olderCursor));
  const timing = { tools: {}, replies: {} };
  for (const annotation of Object.values(page.history.annotations) as any[]) {
    Object.assign(timing.tools, annotation.timing?.tools);
    Object.assign(timing.replies, annotation.timing?.replies);
  }
  expect(timing).toEqual(legacy.extensionState.timing);
  expect(page.toolProgress).toMatchObject(legacy.toolProgress);
});
