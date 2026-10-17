import { executionModels } from '../../src/server/models/execution';
import { fixtureModels } from '../fixture-model';
import { expect, it } from 'vitest';
import { fromAgUiMessages } from '@assistant-ui/react-ag-ui';
import { commandSchema } from '../../src/shared/contracts';
import { IMAGE_LIMITS, imagesSchema } from '../../src/shared/images';
import { toMessages } from '../../src/shared/stream';
import { createSubmitter } from '../../src/browser/chat/session/submission';
const image = {
  name: 'pixel.png',
  mimeType: 'image/png' as const,
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jlp0AAAAASUVORK5CYII=',
};
it('accepts image-only input, rejects non-images, empty messages and bounded totals', () => {
  const command = { runId: crypto.randomUUID(), text: '', images: [image] };
  expect(commandSchema.safeParse(command).success).toBe(true);
  expect(commandSchema.safeParse({ ...command, images: undefined }).success).toBe(false);
  for (const invalid of [
    { ...image, mimeType: 'image/svg+xml' },
    { ...image, data: btoa('not a PNG') },
    { ...image, data: '!!!!' },
  ])
    expect(imagesSchema.safeParse([invalid]).success).toBe(false);
  expect(imagesSchema.safeParse(Array(5).fill(image)).success).toBe(false);
  const data = btoa('\x89PNG\r\n\x1a\n' + 'x'.repeat(IMAGE_LIMITS.bytes / 2));
  expect(
    imagesSchema.safeParse([
      { ...image, data },
      { ...image, data },
    ]).success,
  ).toBe(false);
});
it('projects native Pi images into assistant-ui restored attachments without dropping text', () => {
  const messages = toMessages([
    {
      id: 1,
      kind: 'app.input',
      model: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this' },
            { type: 'image', data: image.data, mimeType: image.mimeType },
          ],
          timestamp: 1,
        },
      ],
    },
  ] as any);
  const restored = fromAgUiMessages(messages)[0];
  expect(restored?.content).toBe('Describe this');
  expect(restored?.attachments?.[0]?.content).toEqual([
    { type: 'image', image: `data:image/png;base64,${image.data}`, filename: 'image' },
  ]);
});
it('freezes bytes across receipt retry and treats changed images as a new input', async () => {
  const commands: any[] = [];
  const send = createSubmitter(async (command) => {
    commands.push(command);
    throw new Error('lost');
  });
  const images = [{ ...image }];
  await expect(send('Describe', undefined, undefined, images)).rejects.toThrow('lost');
  images[0]!.name = 'new.png';
  expect(commands[0].images[0].name).toBe('pixel.png');
  await expect(send('Describe', undefined, undefined, [image])).rejects.toThrow('lost');
  expect(commands[1]).toEqual(commands[0]);
  await expect(send('Describe', undefined, undefined, images)).rejects.toThrow('lost');
  expect(commands[2].runId).not.toBe(commands[0].runId);
});

it('checks the actual step model so a queued image input cannot silently use a text-only model', async () => {
  const models = executionModels(fixtureModels());
  const context = {
    messages: [
      {
        role: 'user' as const,
        content: [{ type: 'image' as const, data: image.data, mimeType: image.mimeType }],
        timestamp: 1,
      },
    ],
  };
  for (const stream of [models.stream, models.streamSimple]) {
    const failed = await stream(models.getModel('fixture', 'fixture')!, context).result();
    expect(failed.stopReason).toBe('error');
    expect(failed.errorMessage).toContain('不支持图片');
    const success = await stream(models.getModel('fixture', 'fixture-pro')!, context).result();
    expect(success.stopReason).toBe('stop');
    expect(JSON.stringify(success.content)).toContain(image.data);
  }
});
