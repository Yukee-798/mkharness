import { env } from 'cloudflare:test';
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
