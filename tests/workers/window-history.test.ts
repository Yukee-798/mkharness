import { abortAllDurableObjects } from 'cloudflare:test';
import { env, runInDurableObject } from './env';
import { UserEntry } from '@earendil-works/pi-durable';
import { it, expect, vi } from 'vitest';
import { BG } from '../../src/server/chat/context';

it.each([1000, 10000])(
  'reads a bounded window from the first native indexed write (%s entries)',
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
      const sql = vi.spyOn(state.storage.sql, 'exec');
      try {
        const latest = JSON.parse(await instance.snapshot());
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
            tx.appendEntry(UserEntry, root.id, {
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
  const toolResult = original.entries.findLast(
    (entry: any) => entry.model?.[0]?.role === 'toolResult',
  );
  expect(toolResult).toBeDefined();
  const trailing = original.entries.filter((entry: any) => entry.id > toolResult.id).length;
  await runInDurableObject(stub, async (instance) => {
    const root = await instance.root();
    await root.commit(async (tx) => {
      for (let n = 0; n < 99 - trailing; n++)
        await tx.appendEntry(UserEntry, root.id, {
          model: [{ role: 'user', content: 'padding ' + n, timestamp: n }],
        });
    }, BG);
  });
  const latest = JSON.parse(await stub.snapshot());
  expect(latest.entries[0].id).toBe(original.entries[0].id);
  const replies = Object.assign(
    {},
    ...Object.values(latest.history.annotations).map((value: any) => value.timing?.replies),
  );
  expect(replies).toEqual(
    Object.assign(
      {},
      ...Object.values(original.history.annotations).map((value: any) => value.timing?.replies),
    ),
  );
});

it('restores indexed timing and tool progress on older pages after native reconstruction', async () => {
  const name = crypto.randomUUID();
  let stub = env.CONVERSATIONS.getByName(name);
  const runId = crypto.randomUUID();
  await stub.submitRun({ runId, text: 'progress seam' });
  await (await stub.observeRun(runId)).text();
  const original = JSON.parse(await stub.snapshot());
  await runInDurableObject(stub, async (instance) => {
    const conversation = await instance.root();
    await conversation.commit(async (tx) => {
      for (let n = 0; n < 250; n++)
        await tx.appendEntry(UserEntry, conversation.id, {
          model: [{ role: 'user', content: 'later ' + n, timestamp: n }],
        });
    }, BG);
  });
  await abortAllDurableObjects();
  stub = env.CONVERSATIONS.getByName(name);
  let page = JSON.parse(await stub.snapshot());
  while (page.history.olderCursor)
    page = JSON.parse(await stub.readHistory(page.history.olderCursor));
  expect(page.history.annotations).toEqual(original.history.annotations);
  expect(page.toolProgress).toMatchObject(original.toolProgress);
});
