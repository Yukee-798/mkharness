import { env, runInDurableObject } from 'cloudflare:test';
import type { ConversationId } from '@earendil-works/pi-durable';
import type { SqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite';
import { expect, it } from 'vitest';
import { ChatResources } from '../../src/server/chat/resources';
import { openChatStorage } from '../../src/server/chat/storage';
import type { ServerContribution } from '../../src/server/extensions/contributions';
import { AppError } from '../../src/shared/contracts';
import type { Json } from '../../src/shared/json';
import type { StorageProbe } from './entry';

const probes = (env as unknown as { STORAGE_PROBES: DurableObjectNamespace<StorageProbe> })
  .STORAGE_PROBES;
const target = (id: number) => id as ConversationId;
const writable = (id = 'widget'): ServerContribution => ({
  id,
  resources: {
    read: async (ref, context) => ({
      data: { ref, target: context.nativeConversationId },
      initialState: { value: 'initial' },
    }),
    validateState(state) {
      if (typeof state !== 'object' || state === null || !('value' in state))
        throw new Error('value required');
      return { value: (state as { value: Json }).value };
    },
  },
});
function resources(database: SqliteDatabase, contributions: readonly ServerContribution[]) {
  return new ChatResources({
    database,
    contributions: async () => contributions,
    readContext: (id) => ({
      nativeConversationId: Number(id),
      entries: async () => [],
      successfulTool: async () => undefined,
      acceptedInput: async () => undefined,
      acceptedInputForAnswer: async () => undefined,
    }),
  });
}

it('restores revisions while isolating native targets, extensions and private chat stores', async () => {
  await runInDurableObject(probes.get(probes.newUniqueId()), async (_instance, state) => {
    const { database } = await openChatStorage(state.storage);
    const source = [writable(), writable('other')];
    const first = resources(database, source);
    expect(await first.read(target(1), 'widget', 'panel')).toEqual({
      ref: 'panel',
      data: { ref: 'panel', target: 1 },
      state: { value: 'initial' },
      revision: 0,
    });
    expect(await first.save(target(1), 'widget', 'panel', { value: 'saved' }, 0)).toEqual({
      revision: 1,
    });
    const reopened = resources(database, source);
    expect(await reopened.read(target(1), 'widget', 'panel')).toMatchObject({
      state: { value: 'saved' },
      revision: 1,
    });
    for (const [id, extension] of [
      [2, 'widget'],
      [1, 'other'],
    ] as const)
      expect(await reopened.read(target(id), extension, 'panel')).toMatchObject({
        data: { target: id },
        state: { value: 'initial' },
        revision: 0,
      });
    await database.close();
  });
  await runInDurableObject(probes.get(probes.newUniqueId()), async (_instance, state) => {
    const { database } = await openChatStorage(state.storage);
    expect(
      await resources(database, [writable()]).read(target(1), 'widget', 'panel'),
    ).toMatchObject({
      state: { value: 'initial' },
      revision: 0,
    });
    await database.close();
  });
});

it('allows one CAS winner and leaves the committed state intact on stale revisions', async () => {
  await runInDurableObject(probes.get(probes.newUniqueId()), async (_instance, state) => {
    const { database, index } = await openChatStorage(state.storage);
    const panels = resources(database, [writable()]);
    const revision = await index.revision();
    const attempts = await Promise.allSettled([
      panels.save(target(1), 'widget', 'panel', { value: 'a' }, 0),
      panels.save(target(1), 'widget', 'panel', { value: 'b' }, 0),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.find((attempt) => attempt.status === 'rejected')).toMatchObject({
      reason: { status: 409, code: 'revision_conflict' },
    });
    const saved = await panels.read(target(1), 'widget', 'panel');
    expect(saved.revision).toBe(1);
    await expect(
      panels.save(target(1), 'widget', 'panel', { value: 'stale' }, 0),
    ).rejects.toMatchObject({
      code: 'revision_conflict',
    });
    expect(await panels.read(target(1), 'widget', 'panel')).toEqual(saved);
    expect(await panels.save(target(1), 'widget', 'panel', { value: 'updated' }, 1)).toEqual({
      revision: 2,
    });
    expect(await index.revision()).toBe(revision);
    await database.close();
  });
});

it('queues resource CAS behind the shared SQLite transaction and its rollback', async () => {
  await runInDurableObject(probes.get(probes.newUniqueId()), async (_instance, state) => {
    const { database } = await openChatStorage(state.storage);
    const panels = resources(database, [writable()]);
    await panels.read(target(1), 'widget', 'panel');
    let entered!: () => void;
    const active = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transaction = database.transaction(async (tx) => {
      await tx.run(
        'INSERT INTO app_resource_states VALUES(?,?,?,1)',
        1,
        JSON.stringify(['widget', 'panel']),
        JSON.stringify({ value: 'uncommitted' }),
      );
      entered();
      await hold;
      throw new Error('rollback');
    });
    await active;
    let enqueued!: () => void;
    const waiting = new Promise<void>((resolve) => {
      enqueued = resolve;
    });
    const nativeTransaction = database.transaction.bind(database);
    database.transaction = (callback) => {
      enqueued();
      return nativeTransaction(callback);
    };
    const save = panels.save(target(1), 'widget', 'panel', { value: 'committed' }, 0);
    await waiting;
    const rolledBack = expect(transaction).rejects.toThrow('rollback');
    release();
    await rolledBack;
    expect(await save).toEqual({ revision: 1 });
    expect(await panels.read(target(1), 'widget', 'panel')).toMatchObject({
      state: { value: 'committed' },
      revision: 1,
    });
    await database.close();
  });
});

it('validates visibility, finite bounded data, writable state and revisions before persisting', async () => {
  await runInDurableObject(probes.get(probes.newUniqueId()), async (_instance, state) => {
    const { database } = await openChatStorage(state.storage);
    const source: ServerContribution[] = [
      writable(),
      { id: 'read-only', resources: { read: async () => ({ data: {}, initialState: {} }) } },
      {
        id: 'hidden',
        resources: {
          read: async () => {
            throw new AppError(404, 'resource_not_found');
          },
        },
      },
      {
        id: 'large-data',
        resources: { read: async () => ({ data: 'x'.repeat(3 * 1048576), initialState: {} }) },
      },
      { id: 'invalid-data', resources: { read: async () => ({ data: NaN, initialState: {} }) } },
      {
        id: 'invalid-initial',
        resources: { read: async () => ({ data: {}, initialState: 'x'.repeat(1048576) }) },
      },
    ];
    const panels = resources(database, source);
    for (const id of ['missing', 'hidden'])
      await expect(panels.read(target(1), id, 'panel')).rejects.toMatchObject({
        status: 404,
        code: 'resource_not_found',
      });
    for (const id of ['large-data', 'invalid-data', 'invalid-initial'])
      await expect(panels.read(target(1), id, 'panel')).rejects.toMatchObject({
        status: 503,
        code: 'invalid_resource',
      });
    await expect(panels.save(target(1), 'read-only', 'panel', {}, 0)).rejects.toMatchObject({
      status: 405,
      code: 'resource_read_only',
    });
    for (const revision of [-1, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1])
      await expect(
        panels.save(target(1), 'widget', 'panel', { value: 'x' }, revision),
      ).rejects.toMatchObject({
        status: 400,
        code: 'invalid_revision',
      });
    for (const value of [null, { value: Infinity }, { value: '界'.repeat(350000) }])
      await expect(panels.save(target(1), 'widget', 'panel', value, 0)).rejects.toMatchObject({
        status: 400,
        code: 'invalid_state',
      });
    expect(await panels.read(target(1), 'widget', 'panel')).toMatchObject({ revision: 0 });
    await database.close();
  });
});
