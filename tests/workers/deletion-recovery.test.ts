import { abortAllDurableObjects, runDurableObjectAlarm } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { env, runInDurableObject } from './env';
import { BG } from '../../src/server/chat/context';

async function expectErased(stub: ReturnType<typeof env.CONVERSATIONS.getByName>) {
  await runInDurableObject(stub, async (_instance, state) => {
    expect(await state.storage.list()).toEqual(new Map());
    expect(await state.storage.getAlarm()).toBeNull();
    for (const { name } of state.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'pi_%' OR name LIKE 'app_%')",
      )
      .toArray())
      expect(state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) n FROM ' + name).one().n).toBe(
        0,
      );
  });
}

it.each(['put', 'setAlarm'] as const)(
  'keeps an interrupted deletion retryable when the local %s transaction fails',
  async (failure) => {
    const id = crypto.randomUUID();
    const stub = env.CONVERSATIONS.getByName(id);
    const actor = await runInDurableObject(stub, async (instance, state) => {
      const actor = await instance.actor();
      await state.storage.put('private-content', 'erase only after durable intent');
      const transaction = state.storage.transaction.bind(state.storage);
      state.storage.transaction = ((callback) =>
        transaction((tx) =>
          callback(
            new Proxy(tx, {
              get(target, key) {
                if (key === failure)
                  return async () => {
                    throw new Error('local deletion unavailable');
                  };
                const value = Reflect.get(target, key, target);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            }),
          ),
        )) as typeof state.storage.transaction;
      return actor;
    });
    expect(await stub.command(actor, { type: 'delete' })).toMatchObject({ error: { status: 503 } });
    expect(
      await env.DB.prepare('SELECT lifecycle FROM conversations WHERE id=?')
        .bind(id)
        .first('lifecycle'),
    ).toBe('active');
    await abortAllDurableObjects();
    const fresh = env.CONVERSATIONS.getByName(id);
    await runInDurableObject(fresh, async (_instance, state) => {
      expect(await state.storage.get('deleting')).toBeUndefined();
      expect(await state.storage.getAlarm()).toBeNull();
      expect(await state.storage.get('private-content')).toBeDefined();
    });
    expect(await fresh.command(actor, { type: 'delete' })).toMatchObject({ deleting: true });
    await abortAllDurableObjects();
    const cleanup = env.CONVERSATIONS.getByName(id);
    expect(await runDurableObjectAlarm(cleanup)).toBe(true);
    expect(
      await env.DB.prepare('SELECT lifecycle FROM conversations WHERE id=?')
        .bind(id)
        .first('lifecycle'),
    ).toBe('deleted');
    await expectErased(cleanup);
  },
);

it('finishes deletion from its persisted alarm after D1 admission fails and the object is evicted', async () => {
  const id = crypto.randomUUID();
  const stub = env.CONVERSATIONS.getByName(id);
  const actor = await runInDurableObject(stub, async (instance, state) => {
    const actor = await instance.actor();
    const root = await instance.root();
    await root.submit({ type: 'input', content: 'private deletion payload' }, BG);
    await root.waitForIdle(BG);
    expect(JSON.stringify((await root.context(BG)).messages)).toContain('private deletion payload');
    await state.storage.put('private-content', 'erase after D1 recovers');
    return actor;
  });
  const trigger = 'fail_deletion_' + id.replaceAll('-', '_');
  await env.DB.prepare(
    `CREATE TRIGGER ${trigger} BEFORE UPDATE OF lifecycle ON conversations
     WHEN NEW.id='${id}' AND NEW.lifecycle='deleting'
     BEGIN SELECT RAISE(ABORT,'fixture D1 deletion admission unavailable'); END`,
  ).run();
  try {
    expect(await stub.command(actor, { type: 'delete' })).toMatchObject({ error: { status: 503 } });
    expect(
      await env.DB.prepare('SELECT lifecycle FROM conversations WHERE id=?')
        .bind(id)
        .first('lifecycle'),
    ).toBe('active');
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get('deleting')).toBe(true);
      expect(await state.storage.getAlarm()).not.toBeNull();
      expect(await state.storage.get('private-content')).toBe('erase after D1 recovers');
    });
    await abortAllDurableObjects();
  } finally {
    await env.DB.prepare(`DROP TRIGGER ${trigger}`).run();
  }

  const cleanup = env.CONVERSATIONS.getByName(id);
  await runInDurableObject(cleanup, async (_instance, state) => {
    expect(await state.storage.get('deleting')).toBe(true);
    expect(await state.storage.getAlarm()).not.toBeNull();
    expect(await state.storage.get('private-content')).toBeDefined();
  });
  // No second DELETE: the intent saved before the failed D1 write drives recovery.
  expect(await runDurableObjectAlarm(cleanup)).toBe(true);
  expect(
    await env.DB.prepare('SELECT lifecycle FROM conversations WHERE id=?')
      .bind(id)
      .first('lifecycle'),
  ).toBe('deleted');
  await expectErased(cleanup);

  for (let repeat = 0; repeat < 2; repeat++) {
    await abortAllDurableObjects();
    const fresh = env.CONVERSATIONS.getByName(id);
    expect(await fresh.command(actor, { type: 'delete' })).toEqual({ deleting: true });
    await runInDurableObject(fresh, (instance) => instance.alarm());
    expect(await runDurableObjectAlarm(fresh)).toBe(false);
    expect(await fresh.read(actor, { type: 'snapshot' })).toMatchObject({ error: { status: 404 } });
    await expectErased(fresh);
  }
});
