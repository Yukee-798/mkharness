import { createScenarioRegistry, serverPacks } from '../../src/scenarios/server';
import configuration from '../../scenarios.config';
import { exampleManifest } from '../../src/scenarios/example/manifest';
import { exampleWorkspacePack } from '../../src/scenarios/example/server';
import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { ChatRuntime } from '../../src/server/chat/runtime';
import { WorkspaceModule } from '../../src/server/workspace/module';
import { WorkspaceDoc } from '../../src/server/workspace/documents';
import { fixtureModels } from '../fixture-model';
import { BG } from '../../src/server/chat/context';
import type { StorageProbe } from './entry';
import type {
  WorkspaceSnapshot,
  WorkspaceCommand,
  WorkspaceReceipt,
} from '../../src/shared/workspace';
import { createImageTask } from '../../src/extensions/images/runtime';
import type { ImageFiles } from '../../src/extensions/images/store';
const probes = (env as unknown as { STORAGE_PROBES: DurableObjectNamespace<StorageProbe> })
  .STORAGE_PROBES;
const command = (
  name: string,
  input: WorkspaceCommand['input'],
  expected: Record<string, number> = {},
): WorkspaceCommand => ({ requestId: crypto.randomUUID(), name, input, expected });
async function fixture(
  kind: string,
  run: (
    w: WorkspaceModule,
    pi: Awaited<ReturnType<ChatRuntime['open']>>,
    target: Awaited<ReturnType<Awaited<ReturnType<ChatRuntime['open']>>['root']>>,
  ) => Promise<void>,
) {
  await runInDurableObject(probes.get(probes.newUniqueId()), async (_instance, state) => {
    const runtime = new ChatRuntime(state);
    const pi = await runtime.open({
      models: fixtureModels(),
      extensions: [],
      restore: async () => {},
      committed: () => {},
    });
    const root = await pi.root(BG);
    const module = new WorkspaceModule(
      { scenarioId: 'scenario', workspaceId: 'workspace', kind, runtimeName: 'runtime' },
      async () => pi,
      async () => undefined,
      () => runtime.index.revision(),
    );
    try {
      await run(module, pi, root);
    } finally {
      await runtime.close();
    }
  });
}
it('one native transaction owns idempotency, CAS, undo/redo and frozen selections', () =>
  fixture('canvas', async (w, pi, root) => {
    const request = command('canvas.add', {
      title: '方向 A',
      text: '红色',
      position: { x: 0, y: 0 },
    });
    const a = await w.execute(request, root.id, 'user');
    expect(await w.execute(request, root.id, 'user')).toEqual(a);
    await expect(
      w.execute({ ...request, input: { title: 'different' } }, root.id, 'user'),
    ).rejects.toMatchObject({ code: 'request_conflict' });
    const id = a.objectIds[0];
    let snapshot = (await w.read('snapshot')) as unknown as WorkspaceSnapshot;
    expect(snapshot.objects).toHaveLength(1);
    const initial = snapshot.objects[0];
    await pi.commit(
      (tx) => w.freeze(tx, [{ objectId: id, contentVersion: initial.contentVersion }], 'run'),
      BG,
    );
    await w.execute(
      command(
        'canvas.update',
        { ids: [id], positions: { [id]: { x: 100, y: 50 } } },
        { [id]: initial.version },
      ),
      root.id,
      'user',
    );
    await expect(
      w.validate([{ objectId: id, contentVersion: initial.contentVersion }]),
    ).resolves.toHaveLength(1);
    await expect(
      w.execute(
        command('canvas.update', { ids: [id], title: 'stale' }, { [id]: initial.version }),
        root.id,
        'user',
      ),
    ).rejects.toMatchObject({ code: 'workspace_conflict' });
    snapshot = (await w.read('snapshot')) as unknown as WorkspaceSnapshot;
    await w.execute(
      command('canvas.update', { ids: [id], text: '蓝色' }, { [id]: snapshot.objects[0].version }),
      root.id,
      'user',
    );
    await expect(
      w.begin('run', [{ objectId: id, contentVersion: initial.contentVersion }]),
    ).rejects.toMatchObject({ code: 'workspace_selection_conflict' });
    await w.execute(command('workspace.undo', {}), root.id, 'user');
    await w.execute(command('workspace.undo', {}), root.id, 'user');
    await w.execute(command('workspace.undo', {}), root.id, 'user');
    expect(((await w.read('snapshot')) as unknown as WorkspaceSnapshot).objects).toEqual([]);
    await w.execute(command('workspace.redo', {}), root.id, 'user');
    expect(((await w.read('snapshot')) as unknown as WorkspaceSnapshot).objects).toHaveLength(1);
    await expect(
      w.execute(
        command('canvas.update', { ids: [id, 'missing'], title: 'rollback' }, { [id]: 100 }),
        root.id,
        'user',
      ),
    ).rejects.toBeDefined();
    expect(((await w.read('object', { id })) as { title: string }).title).toBe('方向 A');
  }));
it('report source/history are immutable; failed edits retain the current source and restore creates a new revision', () =>
  fixture('agent', async (w, _pi, root) => {
    const first = await w.execute(
      command('report.publish', {
        title: '报告',
        summary: '第一版报告的分析简介。',
        source: '<h1 id="summary">一</h1><script>window.answer=42</script>',
      }),
      root.id,
      'agent',
    );
    const id = first.objectIds[0];
    await expect(
      w.execute(
        command('report.publish', { id, title: '报告', source: 'bad', template: 'unknown' }),
        root.id,
        'agent',
      ),
    ).rejects.toMatchObject({ code: 'object_precondition_required' });
    expect(((await w.read('report', { id })) as { source: string }).source).toContain(
      'window.answer=42',
    );
    const snapshot = (await w.read('snapshot')) as unknown as WorkspaceSnapshot;
    await w.execute(
      command(
        'report.publish',
        { id, title: '报告二', source: '<h1>二</h1>' },
        { [id]: snapshot.objects[0].version },
      ),
      root.id,
      'agent',
    );
    expect(((await w.read('report', { id, revision: 1 })) as { source: string }).source).toContain(
      '一',
    );
    expect(await w.read('report', { id, revision: 1 })).toMatchObject({
      title: '报告',
      summary: '第一版报告的分析简介。',
    });
    expect(await w.read('report', { id })).toMatchObject({ title: '报告二', summary: '' });
    const edited = (await w.read('snapshot')) as unknown as WorkspaceSnapshot;
    await w.execute(
      command('report.restore', { id, revision: 1 }, { [id]: edited.objects[0].version }),
      root.id,
      'user',
    );
    expect(await w.read('report', { id })).toMatchObject({
      revision: 3,
      title: '报告',
      summary: '第一版报告的分析简介。',
      source: expect.stringContaining('一'),
      template: 'general@1',
      dependencies: ['https://cdn.jsdelivr.net/npm/echarts@5.6.0/dist/echarts.min.js'],
    });
    expect(((await w.read('snapshot')) as unknown as WorkspaceSnapshot).objects[0]).toMatchObject({
      title: '报告',
      data: { summary: '第一版报告的分析简介。' },
    });
  }));
it.each(['remove', 'move'] as const)(
  'keeps task results when undoing a pending node %s after completion',
  async (action) => {
    await runInDurableObject(probes.get(probes.newUniqueId()), async (_instance, state) => {
      const runtime = new ChatRuntime(state);
      let submits = 0;
      const task = createImageTask(
        {
          identity: 'fixture',
          submit: async () => {
            submits++;
            return 'remote';
          },
          inspect: async () => ({ status: 'succeeded', urls: ['https://fixture.test/image.png'] }),
        },
        {
          saved: async () => [{ file: 'image-1.png', mediaType: 'image/png', bytes: 67 }],
          save: async () => {
            throw new Error('already saved');
          },
        } as unknown as ImageFiles,
        { pollMs: 1 },
      );
      const pi = await runtime.open({
        models: fixtureModels(),
        extensions: [{ name: 'images', tasks: [task] }],
        restore: async () => {},
        committed: () => {},
      });
      const root = await pi.root(BG);
      const w = new WorkspaceModule(
        { scenarioId: 's', workspaceId: 'w', kind: 'canvas', runtimeName: 'r' },
        async () => pi,
        async () => ({ task, provider: 'fixture' }),
        () => runtime.index.revision(),
      );
      try {
        const input = command('canvas.generate', {
          prompt: '方向',
          title: '方向 A',
          aspectRatio: '1:1',
          resolution: '1K',
          position: { x: 0, y: 0 },
        });
        const receipt: WorkspaceReceipt = await w.execute(input, root.id, 'user');
        expect(await w.execute(input, root.id, 'user')).toEqual(receipt);
        const snapshot = (await w.read('snapshot')) as unknown as WorkspaceSnapshot;
        await w.execute(
          command(
            action === 'remove' ? 'canvas.remove' : 'canvas.update',
            {
              ids: receipt.objectIds,
              ...(action === 'move'
                ? { positions: { [receipt.objectIds[0]]: { x: 100, y: 50 } } }
                : {}),
            },
            { [receipt.objectIds[0]]: snapshot.objects[0].version },
          ),
          root.id,
          'user',
        );
        await pi.resume();
        await expect
          .poll(
            async () =>
              (await pi.snapshot(WorkspaceDoc, BG))?.operations[receipt.operationId!]?.status,
          )
          .toBe('completed');
        const final = (await w.read('snapshot')) as unknown as WorkspaceSnapshot;
        if (action === 'remove') expect(final.objects).toEqual([]);
        else expect(final.objects[0].data.position).toEqual({ x: 100, y: 50 });
        expect(final.assets).toHaveLength(1);
        expect(submits).toBe(1);
        expect(final.assets[0]).not.toHaveProperty('prefix');
        await w.execute(command('workspace.undo', {}), root.id, 'user');
        const restored = (await w.read('snapshot')) as unknown as WorkspaceSnapshot;
        expect(restored.objects[0].data).toMatchObject({
          kind: 'image',
          assetId: restored.assets[0].id,
          position: { x: 0, y: 0 },
        });
        expect(restored.operations[0].status).toBe('completed');
        await w.execute(command('workspace.redo', {}), root.id, 'user');
        const redone = (await w.read('snapshot')) as unknown as WorkspaceSnapshot;
        if (action === 'remove') expect(redone.objects).toEqual([]);
        else
          expect(redone.objects[0].data).toMatchObject({
            kind: 'image',
            assetId: redone.assets[0].id,
            position: { x: 100, y: 50 },
          });
        expect(submits).toBe(1);
      } finally {
        await runtime.close();
      }
    });
  },
);

it('a trusted package adds model commands through registration and config, with no host branches', async () => {
  const registry = createScenarioRegistry(
    {
      ...configuration,
      packs: [...configuration.packs, exampleManifest],
      scenes: configuration.scenes.map((s) =>
        s.id === 'canvas' ? { ...s, packs: [...s.packs, exampleManifest.id] } : s,
      ),
    },
    [...serverPacks, exampleWorkspacePack],
    ['canvas', 'reports'],
  );
  await runInDurableObject(probes.get(probes.newUniqueId()), async (_instance, state) => {
    const runtime = new ChatRuntime(state);
    const pi = await runtime.open({
      models: fixtureModels(),
      extensions: [],
      restore: async () => {},
      committed: () => {},
    });
    const root = await pi.root(BG);
    try {
      const workspace = new WorkspaceModule(
        { scenarioId: 's', workspaceId: 'w', kind: 'canvas', runtimeName: 'r' },
        async () => pi,
        async () => undefined,
        () => runtime.index.revision(),
        registry,
      );
      const result = await workspace.execute(
        command('example.note', { title: '来自自定义包' }),
        root.id,
        'agent',
      );
      expect(await workspace.read('object', { id: result.objectIds[0] })).toMatchObject({
        type: 'canvas.node',
        title: '来自自定义包',
      });
    } finally {
      await runtime.close();
    }
  });
});
