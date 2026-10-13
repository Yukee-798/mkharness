import { env, runInDurableObject, abortAllDurableObjects } from 'cloudflare:test';
import { LiveDoc } from '@earendil-works/pi-durable';
import { expect, it } from 'vitest';
import { BG } from '../../src/server/conversation';

it('projects native compaction model-resolution failure in REST and SSE without exposing the error, including reconstruction', async () => {
  let stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const runId = crypto.randomUUID();
  await stub.submitRun({ runId, text: 'plain prior answer' });
  await (await stub.observeRun(runId)).text();
  const issue = await runInDurableObject(stub, async (instance) => {
    const root = await instance.root();
    await root.configure(
      {
        model: { provider: 'PRIVATE_COMPACTION_CONFIG', modelId: 'missing' },
        thinkingLevel: 'off',
      },
      BG,
    );
    const taskId = await root.compact(undefined, BG);
    const pi = await instance.harness.pi();
    await expect
      .poll(async () => (await pi.snapshot(LiveDoc, root.id, BG))?.compactionFailure?.taskId)
      .toBe(taskId);
    expect((await pi.getTask(taskId, BG))?.state).toMatchObject({
      status: 'terminal',
      outcome: { status: 'failed' },
    });
    const issue = { taskId: Number(taskId), code: 'compaction_failed' };
    const snapshot = await instance.snapshot();
    expect(JSON.parse(snapshot).runtimeIssues).toContainEqual(issue);
    expect(snapshot).not.toContain('PRIVATE_COMPACTION_CONFIG');
    const stream = await (await instance.observeRun(runId)).text();
    const states = stream
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)))
      .filter((event) => event.type === 'STATE_SNAPSHOT');
    expect(states.at(-1).snapshot.runtimeIssues).toEqual([issue]);
    expect(stream).not.toContain('PRIVATE_COMPACTION_CONFIG');
    return issue;
  });
  await abortAllDurableObjects();
  stub = env.CONVERSATIONS.get(stub.id);
  expect(JSON.parse(await stub.snapshot()).runtimeIssues).toContainEqual(issue);
});
