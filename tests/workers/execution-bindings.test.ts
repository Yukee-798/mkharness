import { env, runInDurableObject } from 'cloudflare:test';
import { it, expect, vi } from 'vitest';
import { ExecutionBindings } from '../../src/server/conversations/execution-bindings';
import { executionProviderId } from '../../src/server/models/execution';

it('backfills old receipts once and restores compact execution bindings without rereading payloads', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  await runInDurableObject(stub, async (instance, state) => {
    await instance.root();
    const execution = {
      provider: 'fixture',
      modelId: 'fixture',
      thinkingLevel: 'off' as const,
      credentialRef: { source: 'server' as const, fingerprint: 'fixture' },
    };
    const payload = JSON.stringify({
      request: { runId: crypto.randomUUID(), text: 'large original input '.repeat(1000) },
      execution,
    });
    state.storage.sql.exec('DELETE FROM app_meta WHERE key=?', 'execution-index-v1');
    for (let i = 0; i < 250; i++)
      state.storage.sql.exec(
        'INSERT INTO app_requests(id,payload,accepted) VALUES(?,?,1)',
        'old-' + i,
        payload,
      );
    const refs = [{ provider: await executionProviderId(execution), modelId: execution.modelId }];
    const first = new ExecutionBindings(state.storage);
    expect(await first.restore(refs)).toMatchObject([{ stored: { execution }, accepted: 1 }]);
    expect(state.storage.sql.exec('SELECT count(*) AS n FROM app_request_execution').one().n).toBe(
      250,
    );
    const sql = vi.spyOn(state.storage.sql, 'exec');
    try {
      const cold = new ExecutionBindings(state.storage);
      expect(await cold.restore(refs)).toMatchObject([{ stored: { execution }, accepted: 1 }]);
      expect(
        sql.mock.calls.some(([query]) => /SELECT.*payload.*FROM app_requests/i.test(query)),
      ).toBe(true);
      const payloadReads = sql.mock.calls.flatMap(([query], index) =>
        /SELECT.*payload.*FROM app_requests/i.test(query) ? [sql.mock.results[index]] : [],
      );
      expect(
        payloadReads.every((result) => result.type === 'return' && result.value.rowsRead <= 1),
      ).toBe(true);
      expect(
        state.storage.sql.exec('SELECT payload FROM app_requests WHERE id=?', 'old-0').one()
          .payload,
      ).toBe(payload);
    } finally {
      sql.mockRestore();
    }
  });
});
