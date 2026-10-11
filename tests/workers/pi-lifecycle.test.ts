import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { BG } from '../../src/server/conversation';

it('waits for the old Pi runtime to close before reopening the same harness', async () => {
  const target = env.CONVERSATIONS.getByName(crypto.randomUUID());
  await runInDurableObject(target, async (instance) => {
    const previous = await instance.harness.pi();
    const originalClose = previous.close.bind(previous);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const closingStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    previous.close = async (context) => {
      started();
      await gate;
      return originalClose(context);
    };
    const closing = instance.harness.dispose();
    await closingStarted;
    const concurrentClose = instance.harness.dispose();
    const opening = instance.harness.pi();
    const openedBeforeClose = await Promise.race([
      opening.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    release();
    await Promise.all([closing, concurrentClose]);
    const next = await opening;
    expect(openedBeforeClose).toBe(false);
    expect(next).not.toBe(previous);
    await next.close(BG);
  });
});

it('reopens an interrupted runtime over its existing task without submitting the request again', async () => {
  const target = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const runId = crypto.randomUUID();
  await target.submitRun({ runId, text: 'slow lifecycle recovery' });
  await runInDurableObject(target, async (instance, state) => {
    const previous = await instance.harness.pi();
    await instance.harness.dispose();
    const reopened = await instance.harness.pi();
    expect(reopened).not.toBe(previous);
    expect(state.storage.sql.exec('SELECT count(*) AS n FROM app_requests').one().n).toBe(1);
  });
  let snapshot;
  for (let attempt = 0; attempt < 250; attempt++) {
    snapshot = JSON.parse(await target.snapshot());
    if (!snapshot.pending.length) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(snapshot.pending).toEqual([]);
  const messages = snapshot.entries.flatMap(
    (entry: { model?: { role: string }[] }) => entry.model ?? [],
  );
  expect(messages.filter((message: { role: string }) => message.role === 'user')).toHaveLength(1);
  expect(messages.filter((message: { role: string }) => message.role === 'assistant')).toHaveLength(
    1,
  );
});
