import { abortAllDurableObjects } from 'cloudflare:test';
import { env, runInDurableObject } from './env';
import { it, expect } from 'vitest';
import { ConversationControl } from '../../src/server/chat/documents';
import { BG } from '../../src/server/chat/context';
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
    if (!s.pending.length && !s.stopping) return s;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Recovery did not settle');
}
it('recovers a native Stop intent before resuming queued work', async () => {
  let target = stub();
  const first = { runId: crypto.randomUUID(), text: 'slow stopping' };
  const queued = { runId: crypto.randomUUID(), text: 'must withdraw' };
  await target.submitRun(first);
  await target.submitRun(queued);
  await runInDurableObject(target, async (instance) => {
    const root = await instance.root();
    await root.commit(async (tx) => {
      (await tx.doc(ConversationControl, root.id)).stopping = true;
    }, BG);
  });
  await abortAllDurableObjects();
  target = env.CONVERSATIONS.get(target.id);
  const result = await idle(target);
  expect(result.pending).toEqual([]);
  expect(result.stopping).toBe(false);
  expect(JSON.stringify(result.entries)).not.toContain(queued.text);
  expect(await target.submission(queued.runId)).toMatchObject({
    status: 'unanswered',
    reason: 'aborted',
  });
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
  expect(
    JSON.parse(await target.loadResource('openui', JSON.parse(panels[0].content[0].text).panelRef))
      .data.ui,
  ).toContain('Interactive example');
});
it('resolves an old panel through the public full-history API after actual Pi compaction, and detects two-tab CAS conflicts', async () => {
  const target = stub();
  await target.submitRun({ runId: crypto.randomUUID(), text: 'panel' });
  const initial = await idle(target);
  const panel = initial.entries
    .flatMap((e: any) => e.model ?? [])
    .find((m: any) => m.role === 'toolResult' && m.toolName === 'present_openui');
  const ref = JSON.parse(panel.content[0].text).panelRef;
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
