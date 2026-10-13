import { env, abortAllDurableObjects, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { createExtensionProjection } from '../../src/server/extension-state';
import { BG } from '../../src/server/conversation';

it('projects real Pi tool/run durations over SSE and restores the same facts after DO reconstruction', async () => {
  let stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const runId = crypto.randomUUID();
  await stub.submitRun({ runId, text: 'progress seam' });
  const body = await (await stub.observeRun(runId)).text();
  const events = body
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
  const timing = JSON.parse(await stub.snapshot()).extensionState.timing;
  expect(Object.keys(timing.tools)).toHaveLength(2);
  for (const span of Object.values(timing.tools) as any[])
    expect(span.endedAt - span.startedAt).toBeGreaterThanOrEqual(500);
  const replies = Object.values(timing.replies) as any[];
  expect(replies).toHaveLength(1);
  expect(replies[0].runId).toBe(runId);
  expect(replies[0].endedAt - replies[0].startedAt).toBeGreaterThanOrEqual(1000);
  expect(
    events.some(
      (event) =>
        event.type === 'STATE_SNAPSHOT' &&
        JSON.stringify(event.snapshot.extensionState?.timing) === JSON.stringify(timing),
    ),
  ).toBe(true);
  expect(body).not.toContain('never public');
  await abortAllDurableObjects();
  stub = env.CONVERSATIONS.get(stub.id);
  expect(JSON.parse(await stub.snapshot()).extensionState.timing).toEqual(timing);
});

it('failed native tool receipts retain duration without pretending to succeed', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const runId = crypto.randomUUID();
  await stub.submitRun({ runId, text: 'fault seam' });
  await (await stub.observeRun(runId)).text();
  const snapshot = JSON.parse(await stub.snapshot());
  const [callId] = Object.keys(snapshot.toolProgress);
  expect(snapshot.toolProgress[callId].status).toBe('failed');
  expect(snapshot.extensionState.timing.tools[callId]).toMatchObject({
    startedAt: expect.any(Number),
    endedAt: expect.any(Number),
  });
});

it('a terminate-only generated reply gets its duration without an extra model round', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const runId = crypto.randomUUID();
  await stub.submitRun({ runId, text: 'panel' });
  await (await stub.observeRun(runId)).text();
  const snapshot = JSON.parse(await stub.snapshot());
  const answer = snapshot.entries.find((entry: any) =>
    entry.model?.some(
      (message: any) =>
        message.role === 'assistant' &&
        message.content.some(
          (part: any) => part.type === 'toolCall' && part.name === 'present_openui',
        ),
    ),
  );
  expect(snapshot.extensionState.timing.replies[String(answer.id)]).toMatchObject({
    runId,
    startedAt: expect.any(Number),
    endedAt: expect.any(Number),
  });
  expect(
    snapshot.entries.filter((entry: any) =>
      entry.model?.some((message: any) => message.role === 'assistant'),
    ),
  ).toHaveLength(2);
});

it('optional projections are bounded and isolated, and removing them exposes no native facts', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  await runInDurableObject(stub, async (instance, state) => {
    await instance.root();
    const pi = await instance.harness.pi();
    const subscriptions = vi.spyOn(pi, 'subscribeCommits');
    const before = state.storage.sql.exec('SELECT * FROM pi_durable_metadata').toArray();
    const projection = createExtensionProjection(
      pi,
      [
        {
          id: 'throws',
          projectState: () => {
            throw new Error('private');
          },
        },
        { id: 'oversized', projectState: () => ({ text: 'x'.repeat(1048576) }) },
      ],
      [],
      BG,
    );
    await projection.restore();
    expect(projection.project()).toEqual({
      throws: { unavailable: true },
      oversized: { unavailable: true },
    });
    const absent = createExtensionProjection(pi, [], [], BG);
    await absent.restore();
    expect(absent.project()).toEqual({});
    expect(subscriptions).not.toHaveBeenCalled();
    subscriptions.mockRestore();
    expect(state.storage.sql.exec('SELECT * FROM pi_durable_metadata').toArray()).toEqual(before);
    // Projection did not schedule model work or create a persisted metrics document.
    expect((await pi.inspect(BG)).tasks).toHaveLength(0);
  });
});

it('shares the existing host commit subscription and releases it on completion and detach', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const runId = crypto.randomUUID();
  await stub.submitRun({ runId, text: 'progress seam' });
  await runInDurableObject(stub, async (instance) => {
    const pi = await instance.harness.pi();
    const subscribe = pi.subscribeCommits.bind(pi);
    let active = 0;
    const subscriptions = vi.spyOn(pi, 'subscribeCommits').mockImplementation((listener) => {
      active++;
      const stop = subscribe(listener);
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        active--;
        stop();
      };
    });
    try {
      const response = await instance.observeRun(runId);
      expect(active).toBe(1);
      await response.body!.cancel();
      expect(active).toBe(0);
      await (await instance.observeRun(runId)).text();
      expect(active).toBe(0);
      await instance.snapshot();
      expect(subscriptions).toHaveBeenCalledTimes(2);
    } finally {
      subscriptions.mockRestore();
    }
  });
});
