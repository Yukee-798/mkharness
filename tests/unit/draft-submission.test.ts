import { expect, it } from 'vitest';
import { ComposerDraft, type DraftImage } from '../../src/browser/workbench/composer-drafts';

const image = (id: string): DraftImage => ({
  id,
  input: {
    type: 'image',
    name: id + '.png',
    contentType: 'image/png',
    content: [{ type: 'image', image: 'data:image/png;base64,aGVsbG8=' }],
  },
});

it('confirms only the captured images and restores an untouched draft across repeated failures', async () => {
  const draft = new ComposerDraft();
  draft.restore({ text: 'Original', workspaceReferences: [{ objectId: 'A', contentVersion: 1 }] });
  draft.setImages([image('original')]);
  const attempt = draft.beginSubmission();
  for (let index = 0; index < 2; index++) {
    await expect(
      attempt.run(async () => {
        expect(draft.getSnapshot().text).toBe('');
        expect(draft.getSnapshot().workspaceReferences).toEqual([]);
        throw new Error('Lost receipt');
      }),
    ).rejects.toThrow('Lost receipt');
    expect(draft.getSnapshot().text).toBe('Original');
    expect(draft.getSnapshot().images.map((image) => image.id)).toEqual(['original']);
  }
  draft.setImages([image('original'), image('new')]);
  await attempt.run(async () => 'accepted');
  expect(draft.getSnapshot().text).toBe('');
  expect(draft.getSnapshot().workspaceReferences).toEqual([]);
  expect(draft.getSnapshot().images.map((image) => image.id)).toEqual(['new']);
});

it.each([
  ['text', true],
  ['references', true],
  ['config', true],
  ['text', false],
  ['references', false],
  ['config', false],
] as const)('protects a newer %s during retry (success=%s)', async (change, success) => {
  const draft = new ComposerDraft();
  draft.edit('Original');
  const attempt = draft.beginSubmission();
  await expect(
    attempt.run(async () => {
      throw new Error('Lost receipt');
    }),
  ).rejects.toThrow();
  if (change === 'text') draft.edit('New draft');
  if (change === 'references') draft.setWorkspaceReferences([{ objectId: 'B', contentVersion: 2 }]);
  if (change === 'config')
    draft.setConfig({ provider: 'fixture', modelId: 'new', thinkingLevel: 'off' });
  const newer = draft.getSnapshot();
  const retried = attempt.run(async () => {
    if (!success) throw new Error('Retry failed');
    return 'accepted';
  });
  if (success) await retried;
  else await expect(retried).rejects.toThrow('Retry failed');
  expect(draft.getSnapshot()).toMatchObject({
    text: newer.text,
    source: newer.source,
    workspaceReferences: newer.workspaceReferences,
    config: newer.config,
  });
});
