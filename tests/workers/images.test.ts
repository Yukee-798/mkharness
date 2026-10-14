import { env, abortAllDurableObjects, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { AppError } from '../../src/shared/contracts';
const image = {
  name: 'pixel.png',
  mimeType: 'image/png' as const,
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jlp0AAAAASUVORK5CYII=',
};
it('passes real multimodal input to Pi/provider and recovers a lost receipt with identical bytes', async () => {
  let stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const command = {
    runId: crypto.randomUUID(),
    text: 'Describe the image',
    images: [image],
    config: { provider: 'fixture', modelId: 'fixture-pro', thinkingLevel: 'high' as const },
  };
  await runInDurableObject(stub, async (instance) => {
    const target = instance as any;
    const enqueue = target.enqueue.bind(target);
    target.enqueue = async () => {
      throw new AppError(503, 'receipt_gap');
    };
    expect(await instance.submitRun(command)).toMatchObject({ error: { code: 'receipt_gap' } });
    target.enqueue = enqueue;
  });
  await abortAllDurableObjects();
  stub = env.CONVERSATIONS.get(stub.id);
  expect(await stub.submitRun(command)).toMatchObject({ accepted: true });
  expect(await stub.submitRun(command)).toMatchObject({ accepted: true });
  const events = await (await stub.observeRun(command.runId)).text();
  expect(events).toContain('RUN_FINISHED');
  const snapshot = JSON.parse(await stub.snapshot());
  const users = snapshot.entries.filter((entry: any) => entry.kind === 'pi.user');
  expect(users).toHaveLength(1);
  expect(users[0].model[0].content).toContainEqual({
    type: 'image',
    data: image.data,
    mimeType: image.mimeType,
  });
  // Fixture provider echoes its actual TranscriptContext: this proves image bytes
  // reached the model, not merely the host receipt or browser projection.
  const answer = snapshot.entries.find((entry: any) => entry.kind === 'pi.assistant');
  expect(answer.model[0].content[0].text).toContain(image.data);
  expect(
    await stub.submitRun({ ...command, images: [{ ...image, name: 'different.png' }] }),
  ).toMatchObject({ error: { code: 'request_conflict' } });
  await abortAllDurableObjects();
  expect(
    JSON.stringify(JSON.parse(await env.CONVERSATIONS.get(stub.id).snapshot()).entries),
  ).toContain(image.data);
});
it('rejects a text-only model and invalid file data before accepting an input', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  expect(
    await stub.submitRun({ runId: crypto.randomUUID(), text: '', images: [image] }),
  ).toMatchObject({ error: { code: 'model_images_unsupported' } });
  expect(
    await stub.submitRun({
      runId: crypto.randomUUID(),
      text: 'bad',
      images: [{ ...image, data: btoa('fake') }],
    }),
  ).toMatchObject({ error: { code: 'invalid_request' } });
  expect(JSON.parse(await stub.snapshot()).entries).toHaveLength(0);
});

it('reports an incompatible later step configuration for a queued image rather than dropping it', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const first = crypto.randomUUID();
  expect(await stub.submitRun({ runId: first, text: 'slow first' })).toMatchObject({
    accepted: true,
  });
  // Wait for the first generation to be prepared; its fixture holds the queue.
  await expect
    .poll(async () =>
      JSON.parse(await stub.snapshot()).entries.some((entry: any) => entry.kind === 'pi.user'),
    )
    .toBe(true);
  const queued = crypto.randomUUID();
  expect(
    await stub.submitRun({
      runId: queued,
      text: 'queued image',
      images: [image],
      config: { provider: 'fixture', modelId: 'fixture-pro', thinkingLevel: 'high' },
    }),
  ).toMatchObject({ accepted: true });
  expect(
    await stub.submitRun({
      runId: crypto.randomUUID(),
      text: 'later text input',
      config: { provider: 'fixture', modelId: 'fixture', thinkingLevel: 'low' },
    }),
  ).toMatchObject({ accepted: true });
  await (await stub.observeRun(first)).text();
  await (await stub.observeRun(queued)).text();
  const snapshot = JSON.parse(await stub.snapshot());
  expect(JSON.stringify(snapshot.entries)).toContain('所选模型不支持图片');
  const user = snapshot.entries.find(
    (entry: any) =>
      entry.kind === 'pi.user' && JSON.stringify(entry.model).includes('queued image'),
  );
  expect(user.model[0].content).toContainEqual({
    type: 'image',
    data: image.data,
    mimeType: image.mimeType,
  });
});
