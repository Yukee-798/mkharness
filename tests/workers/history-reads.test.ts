import { env, runInDurableObject } from './env';
import { AssistantEntry, ToolResultEntry, UserEntry } from '@earendil-works/pi-durable';
import { expect, it, vi } from 'vitest';
import { BG } from '../../src/server/chat/context';
import { usage } from '../fixture-model';

it.each([100, 500])(
  'keeps idle snapshot reads proportional to the current page (%s entries)',
  async (size) => {
    const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance, state) => {
      const conversation = await instance.root();
      await conversation.commit(async (tx) => {
        for (let n = 0; n < size; n++)
          await tx.appendEntry(UserEntry, conversation.id, {
            model: [{ role: 'user', content: 'history ' + n, timestamp: n }],
          });
      }, BG);
      const before = state.storage.sql.exec('SELECT * FROM pi_durable_metadata').toArray();
      const sql = vi.spyOn(state.storage.sql, 'exec');
      try {
        const snapshot = JSON.parse(await instance.snapshot());
        expect(snapshot.conversationId).toBe(Number(conversation.id));
        expect(snapshot.entries).toHaveLength(100);
        expect(snapshot.history).toBeDefined();
        expect(snapshot).not.toHaveProperty('cursor');
        const rows = sql.mock.calls.reduce(
          (sum, [query], index) =>
            sum +
            (/\b(?:FROM|JOIN)\s+"?pi_entries\b/i.test(query) &&
            sql.mock.results[index]?.type === 'return'
              ? Number(sql.mock.results[index].value.rowsRead)
              : 0),
          0,
        );
        expect(rows).toBeLessThanOrEqual(220);
        expect(state.storage.sql.exec('SELECT * FROM pi_durable_metadata').toArray()).toEqual(
          before,
        );
      } finally {
        sql.mockRestore();
      }
    });
  },
);

it('reads an old published resource by its native tool round rather than the entire growing history', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const client: any = stub;
  const runId = crypto.randomUUID();
  await client.submitRun({ runId, text: 'panel' });
  await expect.poll(async () => (await client.submission(runId)).status).toBe('done');
  const snapshot = JSON.parse(await stub.snapshot());
  const result = snapshot.entries
    .flatMap((e: any) => e.model ?? [])
    .find((m: any) => m.role === 'toolResult' && m.toolName === 'present_openui');
  const ref = JSON.parse(result.content[0].text).panelRef;
  const rows = await runInDurableObject(stub, async (instance, state) => {
    const before = JSON.parse(await instance.loadResource('openui', ref));
    const root = await instance.root();
    await root.commit(async (tx) => {
      for (let n = 0; n < 500; n++)
        await tx.appendEntry(UserEntry, root.id, {
          model: [{ role: 'user', content: 'later ' + n, timestamp: n }],
        });
    }, BG);
    const sql = vi.spyOn(state.storage.sql, 'exec');
    try {
      expect(JSON.parse(await instance.loadResource('openui', ref))).toEqual(before);
      expect(await instance.saveResourceState('openui', ref, { $cost: '12.' }, 0)).toEqual({
        revision: 1,
      });
      const rows = sql.mock.calls.reduce((sum, [query], i) => {
        const result = sql.mock.results[i];
        return (
          sum +
          (/\b(?:FROM|JOIN)\s+"?pi_entries\b/i.test(query) && result?.type === 'return'
            ? Number(result.value.rowsRead)
            : 0)
        );
      }, 0);
      expect(rows).toBeLessThanOrEqual(420);
      sql.mockClear();
      const prefix = ref.slice(0, ref.indexOf('.'));
      for (const invalid of [prefix + '.absent', prefix + '.%ZZ'])
        expect(JSON.parse(await instance.loadResource('openui', invalid))).toMatchObject({
          error: { code: 'resource_not_found' },
        });
      const invalidRows = sql.mock.calls.reduce((sum, [query], i) => {
        const result = sql.mock.results[i];
        return (
          sum +
          (/\b(?:FROM|JOIN)\s+"?pi_entries\b/i.test(query) && result?.type === 'return'
            ? Number(result.value.rowsRead)
            : 0)
        );
      }, 0);
      expect(invalidRows).toBeLessThanOrEqual(4);
      return rows;
    } finally {
      sql.mockRestore();
    }
  });
  console.log('RESOURCE_READS', rows);
});

it.each([true, false])(
  'stops at an unsuccessful original tool result (isError=%s)',
  async (isError) => {
    const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance, state) => {
      const root = await instance.root();
      const ref = await root.commit(async (tx) => {
        const source = await tx.appendEntry(AssistantEntry, root.id, {
          model: [
            {
              role: 'assistant',
              api: 'openai-responses',
              provider: 'fixture',
              model: 'fixture',
              content: [{ type: 'toolCall', id: 'failed', name: 'present_openui', arguments: {} }],
              usage,
              stopReason: 'toolUse',
              timestamp: Date.now(),
            },
          ],
        });
        const ref = `${source.id}.failed`;
        await tx.appendEntry(ToolResultEntry, root.id, {
          data: { diagnostics: [] },
          model: [
            {
              role: 'toolResult',
              toolCallId: 'failed',
              toolName: 'present_openui',
              content: [{ type: 'text', text: 'unpublished' }],
              isError,
              ...(isError ? { details: { ref } } : {}),
              timestamp: Date.now(),
            },
          ],
        });
        for (let n = 0; n < 500; n++)
          await tx.appendEntry(UserEntry, root.id, {
            model: [{ role: 'user', content: 'later ' + n, timestamp: n }],
          });
        return ref;
      }, BG);
      const sql = vi.spyOn(state.storage.sql, 'exec');
      try {
        expect(JSON.parse(await instance.loadResource('openui', ref))).toMatchObject({
          error: { code: 'resource_not_found' },
        });
        const rows = sql.mock.calls.reduce((sum, [query], i) => {
          const result = sql.mock.results[i];
          return (
            sum +
            (/\b(?:FROM|JOIN)\s+"?pi_entries\b/i.test(query) && result?.type === 'return'
              ? Number(result.value.rowsRead)
              : 0)
          );
        }, 0);
        expect(rows).toBeLessThanOrEqual(220);
      } finally {
        sql.mockRestore();
      }
    });
  },
);
