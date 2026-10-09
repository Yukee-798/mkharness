import { env } from 'cloudflare:test';
import { it, expect } from 'vitest';
async function settle(stub: ReturnType<typeof env.CONVERSATIONS.getByName>) {
  for (let i = 0; i < 500; i++) {
    const snapshot = JSON.parse(await stub.snapshot());
    if (!snapshot.pending.length) return snapshot;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Limit did not settle the submission');
}
it('a repeatedly invalid generated program gets only its initial attempt and two repairs', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID()),
    runId = crypto.randomUUID();
  await stub.submitRun({ runId, text: 'invalid_program' });
  const snapshot = await settle(stub);
  const failures = snapshot.entries
    .flatMap((e: any) => e.model ?? [])
    .filter((m: any) => m.role === 'toolResult' && m.toolName === 'prepare_program' && m.isError);
  expect(failures).toHaveLength(3);
  expect(await (await stub.observeRun(runId)).text()).toContain('RUN_ERROR');
});
it('an agent that keeps calling tools terminates at twenty model rounds', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID()),
    runId = crypto.randomUUID();
  await stub.submitRun({ runId, text: 'loop_model' });
  const snapshot = await settle(stub);
  expect(
    snapshot.entries.filter(
      (e: any) => e.kind === 'pi.assistant' && e.model?.[0]?.stopReason !== 'error',
    ),
  ).toHaveLength(20);
  expect(await (await stub.observeRun(runId)).text()).toContain('RUN_ERROR');
});
