import { abortAllDurableObjects } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { env, runInDurableObject } from './env';
import { fixturePNG } from './image-entry';

it('resumes the committed provider task after reconstruction and streams owned image downloads without another generation', async () => {
  let stub = env.IMAGE_PROBES.getByName(crypto.randomUUID());
  await stub.imageProbe('pending');
  const runId = crypto.randomUUID();
  await stub.submitRun({ runId, text: 'image_generation_probe' });
  const observation = (await stub.observeRun(runId)).text();
  await expect
    .poll(async () => Number((await stub.imageProbe()).poll ?? 0))
    .toBeGreaterThanOrEqual(1);
  await abortAllDurableObjects();
  await observation.catch(() => {});
  stub = env.IMAGE_PROBES.get(stub.id);
  await stub.imageProbe('ready');
  await (await stub.observeRun(runId)).text();
  const snapshot = JSON.parse(await stub.snapshot());
  const generated = snapshot.entries
    .flatMap((entry: any) => entry.model ?? [])
    .find((message: any) => message.role === 'toolResult' && message.toolName === 'generate_image');
  expect(generated.isError).toBe(false);
  const result = JSON.parse(generated.content[0].text);
  expect(result.images).toEqual([
    { file: 'image-1.png', mediaType: 'image/png', bytes: fixturePNG.length },
  ]);
  expect((await stub.imageProbe()).submit).toBe('1');
  expect(JSON.parse(await stub.loadResource('images', result.ref)).data).toEqual(result);
  const actor = await runInDurableObject(stub, (instance) => instance.actor());
  const response = await stub.file(actor, {
    extensionId: 'images',
    ref: result.ref,
    name: 'image-1.png',
    download: true,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Type')).toBe('image/png');
  expect(response.headers.get('Content-Disposition')).toContain('attachment');
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(fixturePNG);
  expect(
    (
      await stub.file(actor, {
        extensionId: 'images',
        ref: result.ref,
        name: '../secret',
        download: false,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await stub.file(
        { ...actor, ownerId: 'another-owner' },
        { extensionId: 'images', ref: result.ref, name: 'image-1.png', download: false },
      )
    ).status,
  ).not.toBe(200);
  const other = env.IMAGE_PROBES.getByName(crypto.randomUUID());
  expect(JSON.parse(await other.loadResource('images', result.ref))).toMatchObject({
    error: { status: 404 },
  });
  await stub.submitRun({ runId, text: 'image_generation_probe' });
  expect((await stub.imageProbe()).submit).toBe('1');
});

it('does not repeat an uncertain paid submission even if the model asks to generate again in the same run', async () => {
  const stub = env.IMAGE_PROBES.getByName(crypto.randomUUID());
  await stub.imageProbe('unknown');
  const runId = crypto.randomUUID();
  await stub.submitRun({ runId, text: 'image_generation_probe repeat' });
  await (await stub.observeRun(runId)).text();
  expect((await stub.imageProbe()).submit).toBe('1');
  expect(await stub.snapshot()).toContain('image_submission_unknown');
  await abortAllDurableObjects();
  expect((await env.IMAGE_PROBES.get(stub.id).imageProbe()).submit).toBe('1');
});
