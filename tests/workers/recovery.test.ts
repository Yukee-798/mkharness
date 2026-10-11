import { env, runInDurableObject, abortAllDurableObjects } from 'cloudflare:test';
import { it, expect } from 'vitest';
import { BG } from '../../src/server/conversation';
const stub = () => env.CONVERSATIONS.getByName(crypto.randomUUID());
async function idle(target: ReturnType<typeof stub>) {
  for (let i = 0; i < 250; i++) {
    const current = env.CONVERSATIONS.get(target.id);
    let s: any;
    try {
      s = JSON.parse(await current.snapshot());
    } catch {
      await new Promise((r) => setTimeout(r, 20));
      continue;
    }
    const recovery = await runInDurableObject(current, (instance) => instance.needsRecovery());
    if (!s.pending.length && !s.stopping && !recovery) return s;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Recovery did not settle');
}
it.each([false, true])(
  'reconciles the request gap across SQLite-preserving eviction (Pi accepted=%s)',
  async (accepted) => {
    let target = stub();
    const command = { runId: crypto.randomUUID(), text: 'gap' };
    await runInDurableObject(target, async (instance, state) => {
      state.storage.sql.exec(
        'INSERT INTO app_requests(id,payload,accepted)VALUES(?,?,0)',
        command.runId,
        JSON.stringify(command),
      );
      if (accepted)
        await instance.harness.submit(command.text, {
          session: '1',
          operationId: command.runId,
          whenBusy: 'followUp',
        });
    });
    await abortAllDurableObjects();
    target = env.CONVERSATIONS.get(target.id);
    const result = await idle(target);
    expect(
      result.entries.flatMap((e: any) => e.model ?? []).filter((m: any) => m.role === 'user'),
    ).toHaveLength(1);
    expect(await target.submitRun(command)).toMatchObject({ accepted: true });
    expect(
      await runInDurableObject(
        target,
        (_instance, state) =>
          state.storage.sql
            .exec('SELECT accepted FROM app_requests WHERE id=?', command.runId)
            .one().accepted,
      ),
    ).toBe(1);
  },
);
it('recovers a persisted Stop intent before reopening admission and withdraws queued work', async () => {
  let target = stub();
  await target.submitRun({ runId: crypto.randomUUID(), text: 'slow stopping' });
  await target.submitRun({ runId: crypto.randomUUID(), text: 'must withdraw' });
  await runInDurableObject(target, (_instance, state) => {
    state.storage.sql.exec(
      'INSERT INTO app_meta(key,value)VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      'stopping',
      '1',
    );
  });
  await abortAllDurableObjects();
  target = env.CONVERSATIONS.get(target.id);
  const result = await idle(target);
  expect(result.stopping).toBe(false);
  expect(result.pending).toEqual([]);
  expect(JSON.stringify(result.entries)).not.toContain('must withdraw');
});
it('safe-replays a publish interrupted before tool-result commit without duplicate panels', async () => {
  let target = stub();
  await runInDurableObject(target, (_instance, state) => {
    state.storage.sql.exec('CREATE TABLE test_fault (key TEXT PRIMARY KEY,value INTEGER)');
    state.storage.sql.exec("INSERT INTO test_fault VALUES('armed',1)");
  });
  await target.submitRun({ runId: crypto.randomUUID(), text: 'panel' });
  let reached = false;
  for (let i = 0; i < 100; i++) {
    reached = await runInDurableObject(
      target,
      (_instance, state) =>
        !!state.storage.sql.exec("SELECT value FROM test_fault WHERE key='reached'").toArray()
          .length,
    );
    if (reached) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(reached).toBe(true);
  await abortAllDurableObjects();
  target = env.CONVERSATIONS.get(target.id);
  const result = await idle(target);
  const panels = result.entries
    .flatMap((e: any) => e.model ?? [])
    .filter((m: any) => m.role === 'toolResult' && m.toolName === 'present_openui' && !m.isError);
  expect(panels).toHaveLength(1);
  expect(JSON.parse(await target.loadResource('openui', panels[0].details.ref)).data.ui).toContain(
    'Interactive example',
  );
});
it('resolves an old panel through the public full-history API after actual Pi compaction, and detects two-tab CAS conflicts', async () => {
  const target = stub();
  await target.submitRun({ runId: crypto.randomUUID(), text: 'panel' });
  const initial = await idle(target);
  const panel = initial.entries
    .flatMap((e: any) => e.model ?? [])
    .find((m: any) => m.role === 'toolResult' && m.toolName === 'present_openui');
  const ref = panel.details.ref;
  const writes = await Promise.all([
    target.saveResourceState('openui', ref, { $cost: '' }, 0),
    target.saveResourceState('openui', ref, { $cost: '1.' }, 0),
  ]);
  expect(writes.filter((w) => 'revision' in w)).toHaveLength(1);
  expect(writes.filter((w) => 'error' in w)).toHaveLength(1);
  await target.submitRun({ runId: crypto.randomUUID(), text: 'long_summary' });
  await idle(target);
  await runInDurableObject(target, async (instance) => {
    const root = await instance.root(),
      task = await root.compact('Summarize previous work briefly.', BG);
    const pi = await instance.harness.pi();
    const outcome = await pi.waitForTask(task, BG);
    expect(outcome.state.outcome?.status).toBe('completed');
  });
  const final = await idle(target);
  expect(final.entries.some((e: any) => e.kind === 'pi.compaction')).toBe(true);
  expect(JSON.parse(await target.loadResource('openui', ref)).data.program.data).toEqual({
    factor: 2,
  });
});
