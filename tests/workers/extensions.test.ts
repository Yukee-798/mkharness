import { defineTask } from '@earendil-works/pi-durable';
import { validateExtensions } from '../../src/server/extensions';
import { BG } from '../../src/server/conversation';
import { env, runInDurableObject, abortAllDurableObjects } from 'cloudflare:test';
import { expect, it } from 'vitest';

it('an async native extension runs through Pi history after UI repair exhaustion', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  await stub.submitRun({ runId: crypto.randomUUID(), text: 'invalid_program' });
  for (let i = 0; i < 200; i++) {
    const s = JSON.parse(await stub.snapshot());
    if (!s.pending.length) {
      const results = s.entries
        .flatMap((e: any) => e.model ?? [])
        .filter((m: any) => m.role === 'toolResult');
      expect(results.filter((r: any) => r.toolName === 'prepare_program')).toHaveLength(3);
      expect(results.find((r: any) => r.toolName === 'describe_text')).toMatchObject({
        isError: false,
      });
      return;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Extension did not settle');
});

it('missing native task definitions settle with an explicit recovery diagnostic', async () => {
  let stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const taskId = await runInDurableObject(stub, async (instance) => {
    const root = await instance.root();
    const removed = defineTask({
      name: 'removed.example',
      version: 1,
      initial: () => ({ phase: 'work' as const }),
      phases: { work: async () => {} },
      abort: async () => {},
    });
    return Number(
      await root.commit(
        (tx) => tx.createTask(removed, {}, { ownership: { kind: 'conversation' } }),
        BG,
      ),
    );
  });
  await abortAllDurableObjects();
  stub = env.CONVERSATIONS.get(stub.id);
  for (let i = 0; i < 100; i++) {
    const snapshot = JSON.parse(await stub.snapshot());
    if (snapshot.runtimeIssues.length) {
      expect(snapshot.runtimeIssues).toContainEqual({
        taskId,
        code: 'task_definition_unavailable',
      });
      return;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Missing definition remained live');
});

it('optional UI can be disabled without removing local tools or base rules', async () => {
  const { applicationExtensions } = await import('../../src/server/assembly');
  const extensions = await applicationExtensions(
    { ENABLE_GENERATIVE_UI: '0' } as any,
    async () => [],
  );
  validateExtensions(extensions);
  expect(extensions.flatMap((e) => e.tools ?? []).map((t) => t.name)).toContain('describe_text');
  expect(extensions.flatMap((e) => e.tools ?? []).map((t) => t.name)).not.toContain(
    'present_openui',
  );
  expect(extensions.flatMap((e) => e.sections ?? []).map((s) => s.key)).not.toContain(
    'execution-contract',
  );
});
