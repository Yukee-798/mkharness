import { env, runInDurableObject } from './env';
import { abortAllDurableObjects } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { makeSignature } from 'better-auth/crypto';
import app from '../../src/server/index';
import { BG } from '../../src/server/chat/context';
import type { ConversationSnapshot } from '../../src/shared/conversation';
import type { Harness } from '@earendil-works/pi-durable';

it('initializes one main conversation when fresh snapshot reads race the first submission', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const actor = await stub.actor();
  const command = { runId: crypto.randomUUID(), text: 'first concurrent message' };
  const replies = await runInDurableObject(stub, async (instance) => {
    const host = instance as unknown as { env: Env; pi(): Promise<Harness> };
    const database = host.env.DB,
      open = host.pi;
    let checked = 0,
      releaseChecks!: () => void,
      releaseOpening!: () => void;
    const checkedBoth = new Promise<void>((resolve) => (releaseChecks = resolve));
    const opening = new Promise<void>((resolve) => (releaseOpening = resolve));
    // Both first callers must pass the directory check. Release the second only
    // after open() captures the first manifest, reproducing asynchronous D1 I/O.
    host.env.DB = new Proxy(database, {
      get(target, key) {
        if (key !== 'prepare') {
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (sql: string) => {
          if (
            sql !==
            'SELECT lifecycle FROM conversations WHERE id=? AND owner=? AND instance_generation=?'
          )
            return target.prepare(sql);
          return {
            bind: (...values: unknown[]) => ({
              first: async () => {
                const result = await target
                  .prepare(sql)
                  .bind(...values)
                  .first('lifecycle');
                const index = ++checked;
                if (index === 2) releaseChecks();
                await checkedBoth;
                if (index === 2) await opening;
                return result;
              },
            }),
          };
        };
      },
    });
    host.pi = () => {
      const promise = open.call(host);
      releaseOpening();
      return promise;
    };
    try {
      return await Promise.all([
        instance.read(actor, { type: 'snapshot' }),
        instance.command(actor, { type: 'submit', command }),
      ]);
    } finally {
      host.env.DB = database;
      host.pi = open;
    }
  });
  expect(replies).toEqual([
    expect.objectContaining({ conversationId: expect.any(Number) }),
    { runId: command.runId, accepted: true },
  ]);
  const initial = replies[0] as ConversationSnapshot;
  await (await stub.observe(actor, { runId: command.runId })).text();
  expect(await stub.command(actor, { type: 'submit', command })).toEqual(replies[1]);
  await abortAllDurableObjects();
  const restored = env.CONVERSATIONS.get(stub.id);
  expect(await restored.command(actor, { type: 'submit', command })).toEqual(replies[1]);
  const snapshot = (await restored.read(actor, { type: 'snapshot' })) as ConversationSnapshot;
  expect(snapshot.conversationId).toBe(initial.conversationId);
  expect(snapshot.entries.filter((entry) => entry.kind === 'app.input')).toHaveLength(1);
  expect(snapshot.pending).toEqual([]);
  expect(
    await runInDurableObject(restored, async (instance) =>
      (await instance.harness.pi()).commit((tx) => tx.scanConversations({}, 10), BG),
    ),
  ).toMatchObject({ items: [expect.objectContaining({ id: initial.conversationId })] });
});

it.each(['snapshot-first', 'submission-first'])(
  'accepts a fresh HTTP chat and its first input with concurrent requests (%s)',
  async (order) => {
    const owner = crypto.randomUUID(),
      token = crypto.randomUUID(),
      now = Date.now();
    await env.DB.prepare(
      'INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)',
    )
      .bind(owner, 'Initialization fixture', owner + '@example.test', 1, now, now)
      .run();
    await env.DB.prepare(
      'INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES(?,?,?,?,?,?)',
    )
      .bind(crypto.randomUUID(), now + 60000, token, now, now, owner)
      .run();
    const headers = {
      cookie:
        'better-auth.session_token=' +
        encodeURIComponent(token + '.' + (await makeSignature(token, env.BETTER_AUTH_SECRET))),
      origin: env.APP_URL,
      'Content-Type': 'application/json',
    };
    const create = await app.request(
      env.APP_URL + '/api/conversations',
      { method: 'POST', headers, body: JSON.stringify({ requestId: crypto.randomUUID() }) },
      env,
    );
    expect(create.status).toBe(201);
    const { id } = (await create.json()) as { id: string };
    const url = env.APP_URL + '/api/conversations/' + id;
    const snapshot = () => app.request(url + '/snapshot', { headers }, env);
    const submit = () =>
      app.request(
        url + '/runs',
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ runId: crypto.randomUUID(), text: 'first HTTP message' }),
        },
        env,
      );
    const replies = await Promise.all(
      order === 'snapshot-first' ? [snapshot(), submit()] : [submit(), snapshot()],
    );
    const observed = await Promise.all(
      replies.map(async (response) => ({ status: response.status, body: await response.json() })),
    );
    expect(observed).toEqual(
      expect.arrayContaining([
        { status: 200, body: expect.objectContaining({ conversationId: expect.any(Number) }) },
        { status: 202, body: expect.objectContaining({ accepted: true }) },
      ]),
    );
  },
);

it('accepts the first submission when no initial snapshot is racing it', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const actor = await stub.actor();
  const command = { runId: crypto.randomUUID(), text: 'first isolated message' };
  expect(await stub.command(actor, { type: 'submit', command })).toEqual({
    runId: command.runId,
    accepted: true,
  });
});
