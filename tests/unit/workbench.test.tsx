import { expect, it } from 'vitest';
import { z } from 'zod';
import { WorkbenchPanels } from '../../src/browser/workbench/panel-state';
import { defineWorkbenchPanel } from '../../src/browser/workbench/panels';
import { ComposerDrafts } from '../../src/browser/workbench/composer-drafts';

const schema = z.object({ ref: z.string(), preview: z.string().optional() });
const preview = defineWorkbenchPanel({
  scope: 'conversation',
  parse: (value) => schema.parse(value),
  key: (value) => value.ref,
  title: () => 'Preview',
  Content: () => null,
  restore: (value) => ({ ref: value.ref }),
});
const workspace = { ...preview, scope: 'workspace' as const };
const definitions = new Map([
  ['example/preview', preview],
  ['example/browser', workspace],
]);
const open = (
  store: WorkbenchPanels,
  ref: string,
  activation: 'explicit' | 'suggested' = 'explicit',
) => store.openPanel({ type: 'example/preview', target: { ref }, activation });

it('suggestions cannot steal selection or reopen a deliberately hidden panel', () => {
  const store = new WorkbenchPanels('owner');
  store.setDefinitions(definitions);
  store.selectChat('one');
  open(store, 'report', 'suggested');
  open(store, 'another', 'suggested');
  expect(store.getSnapshot().active?.target).toEqual({ ref: 'report' });
  expect(store.getSnapshot().latest?.target).toEqual({ ref: 'another' });
  store.hidePanel();
  store.updatePanel('example/preview', { ref: 'report', preview: 'late content' });
  open(store, 'third', 'suggested');
  expect(store.getSnapshot().hidden).toBe(true);
  open(store, 'third');
  expect(store.getSnapshot()).toMatchObject({
    hidden: false,
    latest: null,
    active: { target: { ref: 'third' } },
  });
});

it('restores conversation selections and keeps workspace resources while changing chats', () => {
  const store = new WorkbenchPanels('owner');
  store.setDefinitions(definitions);
  store.selectChat('one');
  open(store, 'one-report');
  store.selectChat('two');
  expect(store.getSnapshot().active).toBeNull();
  open(store, 'two-report');
  store.selectChat('one');
  expect(store.getSnapshot().active?.target).toEqual({ ref: 'one-report' });
  store.openPanel({ type: 'example/browser', target: { ref: 'browser' }, activation: 'explicit' });
  store.selectChat('two');
  store.setDefinitions(new Map(definitions));
  expect(store.getSnapshot().active).toMatchObject({ chatId: null, target: { ref: 'browser' } });
  store.setPageVisible(false);
  expect(store.getSnapshot().pageVisible).toBe(false);
});

it('persists only opted-in references, scopes restoration to the owner and isolates invalid targets', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const store = new WorkbenchPanels('owner', storage);
  store.setDefinitions(definitions);
  store.selectChat('one');
  store.openPanel({
    type: 'example/preview',
    target: { ref: 'saved', preview: 'large generated content' },
    activation: 'explicit',
  });
  expect([...values.values()].join('')).not.toContain('large generated content');
  const restored = new WorkbenchPanels('owner', storage);
  restored.setDefinitions(definitions);
  restored.selectChat('one');
  expect(restored.getSnapshot().active?.target).toEqual({ ref: 'saved' });
  expect(
    restored.openPanel({ type: 'example/preview', target: { ref: 3 }, activation: 'explicit' }),
  ).toEqual({ ok: false, reason: 'invalid_target' });
  expect(restored.getSnapshot().active?.target).toEqual({ ref: 'saved' });
  const other = new WorkbenchPanels('another-owner', storage);
  other.setDefinitions(definitions);
  other.selectChat('one');
  expect(other.getSnapshot().active).toBeNull();
  restored.removeChat('one');
  const deleted = new WorkbenchPanels('owner', storage);
  deleted.setDefinitions(definitions);
  deleted.selectChat('one');
  expect(deleted.getSnapshot().active).toBeNull();
});

it('late acknowledgements clear only the sent text and images, preserving a newer draft', () => {
  const drafts = new ComposerDrafts();
  const draft = drafts.get('one');
  draft.edit('send this');
  const capturedVersion = draft.getSnapshot().version;
  draft.setImages([
    {
      id: 'sent-image',
      input: { type: 'image', name: 'one', contentType: 'image/png', content: [] },
    },
  ]);
  draft.edit('next message');
  draft.setImages([
    ...draft.getSnapshot().images,
    {
      id: 'new-image',
      input: { type: 'image', name: 'two', contentType: 'image/png', content: [] },
    },
  ]);
  draft.clearText(capturedVersion);
  draft.removeImages(new Set(['sent-image']));
  expect(drafts.get('one').getSnapshot()).toMatchObject({
    text: 'next message',
    images: [{ id: 'new-image' }],
  });
  expect(drafts.get('two').getSnapshot().text).toBe('');
});

it('restores workspace selection after reload and removes an invalid active target on definition changes', () => {
  let raw: string | null = null;
  const storage = {
    getItem: () => raw,
    setItem: (_key: string, value: string) => {
      raw = value;
    },
  };
  const store = new WorkbenchPanels('owner', storage);
  store.setDefinitions(definitions);
  store.selectChat('one');
  store.openPanel({ type: 'example/browser', target: { ref: 'browser' }, activation: 'explicit' });
  store.hidePanel();
  const restored = new WorkbenchPanels('owner', storage);
  restored.setDefinitions(definitions);
  restored.selectChat('two');
  expect(restored.getSnapshot()).toMatchObject({
    hidden: true,
    active: { chatId: null, target: { ref: 'browser' } },
  });
  restored.setDefinitions(
    new Map([
      [
        'example/browser',
        {
          ...workspace,
          parse: () => {
            throw new Error('Invalid');
          },
        },
      ],
    ]),
  );
  expect(restored.getSnapshot().active).toBeNull();
});

it('does not reopen retired or unavailable panel types from saved layout', () => {
  const store = new WorkbenchPanels('owner');
  store.setDefinitions(definitions);
  store.selectChat('one');
  open(store, 'saved');
  store.setDefinitions(new Map());
  expect(store.getSnapshot().active).toBeNull();
  store.selectChat('two');
  store.selectChat('one');
  expect(store.getSnapshot().active).toBeNull();
  store.setDefinitions(definitions);
  expect(store.getSnapshot().active?.target).toEqual({ ref: 'saved' });
});
