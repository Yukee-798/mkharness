import { abortAllDurableObjects, runDurableObjectAlarm } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { env, runInDurableObject } from './env';
import { BG } from '../../src/server/chat/context';
import { DirectoryProjection } from '../../src/server/chat/documents';
import type { Harness } from '@earendil-works/pi-durable';
import type { SubmissionObservation } from '../../src/shared/conversation';

it('returns native observation identities and settles through events without a snapshot read', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const actor = await stub.actor();
  const command = { runId: crypto.randomUUID(), text: 'slow receipt' };
  const reply = (await stub.command(actor, { type: 'submit', command })) as {
    observation: SubmissionObservation;
  };
  expect(reply.observation.conversationId).toBeGreaterThan(0);
  expect(reply.observation.pending).toContainEqual({
    operationId: command.runId,
    status: 'running',
  });
  const stream = await (
    await stub.observe(actor, { runId: command.runId, target: reply.observation.conversationId })
  ).text();
  expect(stream).toContain('MESSAGES_SNAPSHOT');
  expect(stream).toContain('RUN_FINISHED');
  expect((await stub.submission(command.runId))?.status).toBe('done');
  const retry = (await stub.command(actor, { type: 'submit', command })) as {
    observation: SubmissionObservation;
  };
  expect(retry.observation.pending).toEqual([]);
  const entries = await runInDurableObject(stub, (instance) => instance.allEntries());
  expect(entries.filter((entry) => entry.kind === 'app.input')).toHaveLength(1);
});

it('acknowledges before a slow directory write and repairs a failed projection after cold restart', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const actor = await stub.actor();
  const command = { runId: crypto.randomUUID(), text: 'Durable directory repair' };
  await runInDurableObject(stub, async (instance, state) => {
    const host = instance as unknown as {
      env: Env;
      pi(): Promise<Harness>;
      projectDirectory(pi: Harness): Promise<void>;
    };
    const database = host.env.DB;
    let rejectWrite!: (error: Error) => void;
    let started!: () => void;
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<never>((_resolve, reject) => {
      rejectWrite = reject;
    });
    host.env.DB = new Proxy(database, {
      get(target, key) {
        if (key === 'prepare')
          return (sql: string) =>
            sql.startsWith('UPDATE conversations SET title=CASE')
              ? {
                  bind: () => ({
                    run: () => {
                      started();
                      return gate;
                    },
                  }),
                }
              : target.prepare(sql);
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    try {
      const result = await instance.command(actor, { type: 'submit', command });
      expect(result).toMatchObject({ accepted: true, runId: command.runId });
      await writing;
      const pi = await host.pi();
      expect(await pi.snapshot(DirectoryProjection, BG)).toMatchObject({
        pending: true,
        title: command.text,
      });
      const flight = host.projectDirectory(pi);
      rejectWrite(new Error('D1 unavailable'));
      await flight;
      expect(await pi.snapshot(DirectoryProjection, BG)).toMatchObject({ pending: true });
      expect(await state.storage.getAlarm()).not.toBeNull();
    } finally {
      host.env.DB = database;
    }
  });
  await (await stub.observe(actor, { runId: command.runId })).text();
  await abortAllDurableObjects();
  const restored = env.CONVERSATIONS.get(stub.id);
  expect(await runDurableObjectAlarm(restored)).toBe(true);
  const row = await env.DB.prepare('SELECT title FROM conversations WHERE id=?')
    .bind(actor.chatId)
    .first();
  expect(row?.title).toBe(command.text);
  await runInDurableObject(restored, async (instance) => {
    expect(await (await instance.harness.pi()).snapshot(DirectoryProjection, BG)).toMatchObject({
      pending: false,
    });
  });
  expect(await restored.command(actor, { type: 'submit', command })).toMatchObject({
    accepted: true,
  });
  const entries = await runInDurableObject(restored, (instance) => instance.allEntries());
  expect(entries.filter((entry) => entry.kind === 'app.input')).toHaveLength(1);
});

it('retains newer projection intent during an older write and preserves custom titles and directory order', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const actor = await stub.actor();
  await runInDurableObject(stub, async (instance) => {
    const host = instance as unknown as {
      env: Env;
      pi(): Promise<Harness>;
      projectDirectory(pi: Harness): Promise<void>;
    };
    const database = host.env.DB;
    let release!: () => void;
    let started!: () => void;
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    host.env.DB = new Proxy(database, {
      get(target, key) {
        if (key === 'prepare')
          return (sql: string) =>
            sql.startsWith('UPDATE conversations SET title=CASE')
              ? {
                  bind: (...values: unknown[]) => ({
                    run: async () => {
                      started();
                      await gate;
                      return target
                        .prepare(sql)
                        .bind(...values)
                        .run();
                    },
                  }),
                }
              : target.prepare(sql);
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    try {
      expect(
        await instance.command(actor, {
          type: 'submit',
          command: { runId: crypto.randomUUID(), text: 'slow first' },
        }),
      ).toMatchObject({ accepted: true });
      await writing;
      const pi = await host.pi();
      const first = await pi.snapshot(DirectoryProjection, BG);
      expect(
        await instance.command(actor, {
          type: 'submit',
          command: { runId: crypto.randomUUID(), text: 'second' },
        }),
      ).toMatchObject({ accepted: true });
      await database
        .prepare('UPDATE conversations SET title=?,title_custom=1,updated_at=? WHERE id=?')
        .bind('My title', Date.now() + 100000, actor.chatId)
        .run();
      const flight = host.projectDirectory(pi);
      release();
      await flight;
      expect(await pi.snapshot(DirectoryProjection, BG)).toMatchObject({
        pending: true,
        revision: first!.revision + 1,
      });
      host.env.DB = database;
      await host.projectDirectory(pi);
      expect(await pi.snapshot(DirectoryProjection, BG)).toMatchObject({ pending: false });
      const row = await database
        .prepare('SELECT title,updated_at FROM conversations WHERE id=?')
        .bind(actor.chatId)
        .first<{ title: string; updated_at: number }>();
      expect(row?.title).toBe('My title');
      expect(row!.updated_at).toBeGreaterThan(Date.now());
    } finally {
      release();
      host.env.DB = database;
    }
  });
  await stub.command(actor, { type: 'stop' });
});

it('retains acceptance if the optional receipt observation cannot be read', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const actor = await stub.actor();
  await runInDurableObject(stub, async (instance) => {
    const host = instance as unknown as { pending(target: number): Promise<unknown[]> };
    const pending = host.pending;
    let calls = 0;
    host.pending = async (target) => {
      if (++calls === 2) throw new Error('Read unavailable after acceptance');
      return pending.call(host, target);
    };
    try {
      expect(
        await instance.command(actor, {
          type: 'submit',
          command: { runId: crypto.randomUUID(), text: 'slow fallback' },
        }),
      ).toMatchObject({ accepted: true });
      expect(calls).toBe(2);
    } finally {
      host.pending = pending;
    }
  });
  await stub.command(actor, { type: 'stop' });
});
