import { ToolTask } from '@earendil-works/pi-durable';
import { BG } from '../../src/server/conversation';
import { env, runInDurableObject, abortAllDurableObjects } from 'cloudflare:test';
import { expect, it } from 'vitest';
function events(body: string) {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
}
it('REST and SSE restore the same canonical progress without duplicating calls or leaking private details', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID()),
    runId = crypto.randomUUID();
  await stub.submitRun({ runId, text: 'progress seam' });
  let restored: any;
  for (let i = 0; i < 100; i++) {
    const snapshot = JSON.parse(await stub.snapshot());
    if (
      Object.values(snapshot.toolProgress).some(
        (progress: any) => progress.value?.phase === 'first',
      )
    ) {
      restored = snapshot;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(restored).toBeDefined();
  expect(JSON.stringify(restored)).not.toContain('never public');
  const attached = events(await (await stub.observeRun(runId)).text());
  const state = attached.find((event) => event.type === 'STATE_SNAPSHOT');
  const firstId = Object.keys(restored.toolProgress).find(
    (id) => restored.toolProgress[id].status === 'running',
  )!;
  expect(state.snapshot.toolProgress[firstId].status).toBe('running');
  expect(attached.filter((event) => event.type === 'TOOL_CALL_START')).toHaveLength(1); // first call already committed before attachment
  const result = JSON.parse(await stub.snapshot());
  expect(Object.keys(result.toolProgress)).toHaveLength(2);
  expect(
    Object.values(result.toolProgress).every(
      (progress: any) => progress.status === 'complete' && !progress.value,
    ),
  ).toBe(true);
  expect(JSON.stringify(attached) + JSON.stringify(result)).not.toContain('never public');
  for (const entry of result.entries) {
    expect(entry).not.toHaveProperty('data');
    for (const message of entry.model ?? [])
      if (message.role === 'toolResult') expect(message).not.toHaveProperty('details');
  }
});
it('native fault with no result entry becomes a restored failure rather than permanent loading', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID()),
    runId = crypto.randomUUID();
  await stub.submitRun({ runId, text: 'fault seam' });
  const attached = events(await (await stub.observeRun(runId)).text());
  const snapshot = JSON.parse(await stub.snapshot());
  expect(Object.values(snapshot.toolProgress)).toEqual([{ status: 'failed' }]);
  expect(
    attached.some(
      (event) =>
        event.type === 'STATE_SNAPSHOT' &&
        Object.values(event.snapshot.toolProgress).some(
          (progress: any) => progress.status === 'failed',
        ),
    ),
  ).toBe(true);
  expect(
    snapshot.entries
      .flatMap((entry: any) => entry.model ?? [])
      .filter((message: any) => message.role === 'toolResult'),
  ).toHaveLength(0);
});

it('restores an older no-result failure even after more than one page of later receipts', async () => {
  let stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const runId = crypto.randomUUID();
  await stub.submitRun({ runId, text: 'fault seam' });
  await (await stub.observeRun(runId)).text();
  await runInDurableObject(stub, async (instance) => {
    const root = await instance.root();
    await root.commit(async (tx) => {
      for (let i = 0; i < 101; i++) {
        const id = await tx.createTask(
          ToolTask,
          { assistant: 1 as any, callId: 'fixture-receipt' },
          { ownership: { kind: 'conversation' } },
        );
        const fixture = tx as any;
        const record = fixture.stagedTasks().find((task: any) => task.id === id)!;
        fixture.setTask({
          ...record,
          state: { status: 'terminal', outcome: { status: 'completed', result: { entryId: 1 } } },
        });
      }
    }, BG);
  });
  await abortAllDurableObjects();
  stub = env.CONVERSATIONS.get(stub.id);
  expect(Object.values(JSON.parse(await stub.snapshot()).toolProgress)).toEqual([
    { status: 'failed' },
  ]);
  const summary = crypto.randomUUID();
  await stub.submitRun({ runId: summary, text: 'long_summary' });
  await (await stub.observeRun(summary)).text();
  await runInDurableObject(stub, async (instance) => {
    const root = await instance.root();
    const task = await root.compact('Summarize previous work briefly.', BG);
    await (await instance.harness.pi()).waitForTask(task, BG);
  });
  const compacted = JSON.parse(await stub.snapshot());
  expect(compacted.entries.some((entry: any) => entry.kind === 'pi.compaction')).toBe(true);
  expect(Object.values(compacted.toolProgress)).toContainEqual({ status: 'failed' });
  const restoredEvents = events(await (await stub.observeRun(summary)).text());
  expect(
    restoredEvents.some(
      (event) =>
        event.type === 'STATE_SNAPSHOT' &&
        Object.values(event.snapshot.toolProgress).some(
          (progress: any) => progress.status === 'failed',
        ),
    ),
  ).toBe(true);
});
