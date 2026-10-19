import { directoryActor, resolveChat } from '../../src/server/chat/directory';
import { runDurableObjectAlarm, abortAllDurableObjects } from 'cloudflare:test';
import type { ChatActor } from '../../src/server/chat/protocol';
import type { ConversationSnapshot } from '../../src/shared/conversation';
import { env, runInDurableObject } from './env';
import { beforeAll, it, expect, vi } from 'vitest';
import { makeSignature } from 'better-auth/crypto';
import app from '../../src/server/index';
const createBody = () => JSON.stringify({ requestId: crypto.randomUUID() });
const cookie = async (token: string) =>
  'better-auth.session_token=' +
  encodeURIComponent(token + '.' + (await makeSignature(token, env.BETTER_AUTH_SECRET!)));
beforeAll(async () => {
  for (const id of ['a', 'b']) {
    await env.DB.prepare(
      'INSERT INTO user(id,name,email,emailVerified,image,createdAt,updatedAt) VALUES(?,?,?,1,NULL,?,?)',
    )
      .bind(id, id, id + '@example.com', Date.now(), Date.now())
      .run();
    await env.DB.prepare('INSERT INTO session VALUES(?,?,?,?,?,NULL,NULL,?)')
      .bind(id, Date.now() + 86400000, 'token-' + id, Date.now(), Date.now(), id)
      .run();
  }
});
it('rejects unauthenticated requests with 401', async () =>
  expect((await app.request('http://localhost:5173/api/conversations', {}, env)).status).toBe(401));
it('requires an explicit create ID and rejects unknown creation fields', async () => {
  const headers = { cookie: await cookie('token-a'), origin: env.APP_URL };
  for (const body of [
    '',
    '{}',
    JSON.stringify({ requestId: 'old-id' }),
    JSON.stringify({ requestId: crypto.randomUUID(), owner: 'b' }),
  ]) {
    const response = await app.request(
      'http://localhost:5173/api/conversations',
      { method: 'POST', headers, body },
      env,
    );
    expect(response.status).toBe(400);
  }
});
it('capabilities are authenticated configuration reads that never acquire a DO', async () => {
  expect((await app.request('http://localhost:5173/api/capabilities', {}, env)).status).toBe(401);
  const unavailableDO = {
    getByName: () => {
      throw new Error('capability read acquired a DO');
    },
  };
  const response = await app.request(
    'http://localhost:5173/api/capabilities',
    {
      headers: { cookie: await cookie('token-a') },
    },
    { ...env, CONVERSATIONS: unavailableDO } as any,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    extensionIds: [
      'workspace',
      'images',
      'skills',
      'mcp',
      'timing',
      'web',
      'openui',
      'reply',
      'async-example',
    ],
    customMcp: true,
    skills: true,
  });
});
it('isolates listing and every resource operation using real Better Auth sessions', async () => {
  const a = await cookie('token-a'),
    b = await cookie('token-b');
  const created = await app.request(
    'http://localhost:5173/api/conversations',
    { method: 'POST', headers: { cookie: a, origin: env.APP_URL }, body: createBody() },
    env,
  );
  expect(created.status).toBe(201);
  const { id } = (await created.json()) as { id: string };
  const list = await app.request(
    'http://localhost:5173/api/conversations',
    { headers: { cookie: b } },
    env,
  );
  expect(await list.json()).toEqual({ items: [], next: null });
  for (const [path, method] of [
    ['snapshot', 'GET'],
    ['runs', 'POST'],
    ['runs/abc/events', 'GET'],
    ['runs/abc/queue', 'POST'],
    ['runs/abc/queue/ack', 'POST'],
    ['extensions/mcp/controls/decide', 'POST'],
    ['stop', 'POST'],
    ['extensions/openui/resources/1.call', 'GET'],
    ['extensions/openui/resources/1.call/state', 'PATCH'],
  ]) {
    const response = await app.request(
      'http://localhost:5173/api/conversations/' + id + '/' + path,
      {
        method,
        headers: { cookie: b, origin: env.APP_URL, 'Content-Type': 'application/json' },
        body: method === 'GET' ? undefined : '{}',
      },
      env,
    );
    expect(response.status).toBe(404);
  }
});
it('validates malformed and oversized input bodies before invoking Pi', async () => {
  const headers = {
    cookie: await cookie('token-a'),
    origin: env.APP_URL,
    'Content-Type': 'application/json',
  };
  const created = await app.request(
    'http://localhost:5173/api/conversations',
    { method: 'POST', headers, body: createBody() },
    env,
  );
  const { id } = (await created.json()) as any;
  const bad = await app.request(
    `http://localhost:5173/api/conversations/${id}/extensions/openui/resources/1.call/state`,
    { method: 'PATCH', headers, body: '{' },
    env,
  );
  expect(bad.status).toBe(400);
  const big = await app.request(
    `http://localhost:5173/api/conversations/${id}/runs`,
    { method: 'POST', headers: { ...headers, 'Content-Length': '2097152' }, body: '{}' },
    env,
  );
  expect(big.status).toBe(413);
});
it('rejects an oversized queue action before invoking the durable object', async () => {
  const headers = { cookie: await cookie('token-a'), origin: env.APP_URL };
  const created = await app.request(
    'http://localhost:5173/api/conversations',
    { method: 'POST', headers, body: createBody() },
    env,
  );
  const { id } = (await created.json()) as { id: string };
  const command = vi.fn(async () => ({ queue: [] }));
  const response = await app.request(
    `http://localhost:5173/api/conversations/${id}/runs/${crypto.randomUUID()}/queue`,
    { method: 'POST', headers, body: ' '.repeat(2048) + '{"action":"remove"}' },
    { ...env, CONVERSATIONS: { getByName: () => ({ command }) } } as unknown as Env,
  );
  expect(response.status).toBe(413);
  expect(command).not.toHaveBeenCalled();
});

it('returns the Better Auth error shape when OAuth is not configured', async () => {
  const response = await app.request(
    'http://localhost:5173/api/auth/get-session',
    {},
    { ...env, GOOGLE_CLIENT_ID: '' },
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    code: 'auth_not_configured',
    message: expect.stringContaining('Google OAuth'),
  });
});

it('renames only owned chats, validates titles and preserves explicit names on submission', async () => {
  const headers = { cookie: await cookie('token-a'), origin: env.APP_URL };
  const created = await app.request(
    'http://localhost:5173/api/conversations',
    { method: 'POST', headers, body: createBody() },
    env,
  );
  const { id } = (await created.json()) as { id: string };
  const url = `http://localhost:5173/api/conversations/${id}`;
  expect(
    (
      await app.request(
        url,
        {
          method: 'PATCH',
          headers: { ...headers, cookie: await cookie('token-b') },
          body: '{"title":"Other"}',
        },
        env,
      )
    ).status,
  ).toBe(404);
  for (const title of ['', ' '.repeat(5), 'x'.repeat(121)]) {
    expect(
      (await app.request(url, { method: 'PATCH', headers, body: JSON.stringify({ title }) }, env))
        .status,
    ).toBe(400);
  }
  const renamed = await app.request(
    url,
    { method: 'PATCH', headers, body: '{"title":"  新聊天  "}' },
    env,
  );
  expect(renamed.status).toBe(200);
  expect(await renamed.json()).toMatchObject({ id, title: '新聊天' });
  const sent = await app.request(
    url + '/runs',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ runId: crypto.randomUUID(), text: 'Do not replace my chosen name' }),
    },
    env,
  );
  expect(sent.status).toBe(202);
  expect(
    await env.DB.prepare('SELECT title FROM conversations WHERE id=?').bind(id).first('title'),
  ).toBe('新聊天');
  await env.CONVERSATIONS.getByName(
    (await resolveChat(env, 'a', id)).runtime_name!,
  ).stopConversation();
});

async function ownedChat() {
  const requestId = crypto.randomUUID();
  const headers = { cookie: await cookie('token-a'), origin: env.APP_URL };
  const response = await app.request(
    'http://localhost:5173/api/conversations',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ requestId }),
    },
    env,
  );
  expect(response.status).toBe(201);
  const { id } = (await response.json()) as { id: string };
  const generation = await env.DB.prepare(
    'SELECT instance_generation FROM conversations WHERE id=?',
  )
    .bind(id)
    .first<string>('instance_generation');
  const row = await resolveChat(env, 'a', id);
  const actor: ChatActor = directoryActor(row);
  expect(actor.generation).toBe(generation);
  return {
    id,
    actor,
    requestId,
    headers,
    target: env.CONVERSATIONS.getByName(row.runtime_name!),
    url: 'http://localhost:5173/api/conversations/' + id,
  };
}

async function expectErased(target: ReturnType<typeof env.CONVERSATIONS.getByName>) {
  await runInDurableObject(target, async (_instance, state) => {
    expect(await state.storage.list()).toEqual(new Map());
    expect(await state.storage.get('manifest')).toBeUndefined();
    expect(await state.storage.get('deleting')).toBeUndefined();
    expect(await state.storage.get('fixture-secret')).toBeUndefined();
    const tables = state.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'pi_%' OR name LIKE 'app_%')",
      )
      .toArray();
    for (const { name } of tables)
      expect(state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) n FROM ' + name).one().n).toBe(
        0,
      );
    expect(await state.storage.getAlarm()).toBeNull();
  });
}

it('accepts empty-chat deletion with a durable tombstone before alarm erasure', async () => {
  const { id, actor, requestId, headers, target, url } = await ownedChat();
  const response = await app.request(url, { method: 'DELETE', headers }, env);
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ deleting: true });
  expect(
    await env.DB.prepare('SELECT lifecycle FROM conversations WHERE id=?')
      .bind(id)
      .first('lifecycle'),
  ).toBe('deleting');
  await runInDurableObject(target, async (_instance, state) => {
    expect(await state.storage.get('deleting')).toBe(true);
    expect(await state.storage.getAlarm()).not.toBeNull();
    const manifest = await state.storage.get<{ mainConversationId?: number }>('manifest');
    expect(manifest?.mainConversationId).toBeUndefined();
    expect(
      state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name LIKE 'pi_%'").toArray(),
    ).toEqual([]);
  });
  expect(
    await target.command(actor, {
      type: 'submit',
      command: { runId: crypto.randomUUID(), text: 'late' },
    }),
  ).toMatchObject({ error: { status: 404 } });
  expect(await runDurableObjectAlarm(target)).toBe(true);
  expect(await env.DB.prepare('SELECT * FROM conversations WHERE id=?').bind(id).first()).toEqual({
    id,
    owner: 'a',
    create_request_id: requestId,
    create_hash: expect.any(String),
    instance_generation: actor.generation,
    lifecycle: 'deleted',
    title: null,
    title_custom: null,
    created_at: null,
    updated_at: null,
  });
  for (const table of [
    'conversation_mcp_bindings',
    'conversation_skill_bindings',
    'conversation_deployment_mcp_bindings',
  ])
    expect(
      await env.DB.prepare('SELECT COUNT(*) n FROM ' + table + ' WHERE conversation=?')
        .bind(id)
        .first('n'),
    ).toBe(0);
  expect((await app.request(url, { method: 'DELETE', headers }, env)).status).toBe(202);
  expect(
    (
      await app.request(
        'http://localhost:5173/api/conversations',
        { method: 'POST', headers, body: JSON.stringify({ requestId }) },
        env,
      )
    ).status,
  ).toBe(410);
  await expectErased(target);
});

it('deletes only owned chats, closes running work and rejects stale actors after erasure', async () => {
  const { id, actor, headers, target, url } = await ownedChat();
  expect(
    (
      await app.request(
        url,
        { method: 'DELETE', headers: { ...headers, cookie: await cookie('token-b') } },
        env,
      )
    ).status,
  ).toBe(404);
  expect(
    await target.command(actor, {
      type: 'submit',
      command: { runId: crypto.randomUUID(), text: 'ignores_cancel' },
    }),
  ).toMatchObject({ accepted: true });
  await vi.waitFor(async () => {
    const snapshot = (await target.read(actor, { type: 'snapshot' })) as ConversationSnapshot;
    expect(
      snapshot.entries.some((entry) =>
        entry.model?.some(
          (message) =>
            message.role === 'assistant' &&
            message.content.some(
              (block) => block.type === 'toolCall' && block.name === 'ignores_cancel',
            ),
        ),
      ),
    ).toBe(true);
  });
  expect(
    await target.command(actor, {
      type: 'submit',
      command: { runId: crypto.randomUUID(), text: 'must not run' },
    }),
  ).toMatchObject({ accepted: true });
  await runInDurableObject(target, async (_instance, state) => {
    await state.storage.put('fixture-secret', 'private draft');
  });
  expect((await app.request(url, { method: 'DELETE', headers }, env)).status).toBe(202);
  expect(
    await target.command(actor, {
      type: 'submit',
      command: { runId: crypto.randomUUID(), text: 'racing submit' },
    }),
  ).toMatchObject({ error: { status: 404 } });
  expect((await app.request(url + '/snapshot', { headers }, env)).status).toBe(404);
  await runDurableObjectAlarm(target);
  await abortAllDurableObjects();
  const fresh = env.CONVERSATIONS.getByName(actor.runtimeName ?? id);
  expect(await fresh.read(actor, { type: 'snapshot' })).toMatchObject({ error: { status: 404 } });
  await expectErased(fresh);
});

it('keeps a persistent cleanup alarm beyond repeated failures and completes after storage recovers', async () => {
  const { id, actor, headers, target, url } = await ownedChat();
  let attempts = 0;
  let restore = () => {};
  await runInDurableObject(target, (_instance, state) => {
    const original = state.storage.deleteAll.bind(state.storage);
    state.storage.deleteAll = async () => {
      attempts++;
      throw new Error('fixture cleanup unavailable');
    };
    restore = () => {
      state.storage.deleteAll = original;
    };
  });
  expect((await app.request(url, { method: 'DELETE', headers }, env)).status).toBe(202);
  try {
    for (let attempt = 0; attempt < 7; attempt++) {
      expect(await runDurableObjectAlarm(target).catch(() => true)).toBe(true);
      await runInDurableObject(target, async (_instance, state) => {
        expect(await state.storage.get('deleting')).toBe(true);
        expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
      });
    }
    expect(attempts).toBe(7);
    expect(await target.read(actor, { type: 'snapshot' })).toMatchObject({
      error: { status: 404 },
    });
    expect(
      await env.DB.prepare('SELECT lifecycle FROM conversations WHERE id=?')
        .bind(id)
        .first('lifecycle'),
    ).toBe('deleted');
  } finally {
    restore();
  }
  expect(await runDurableObjectAlarm(target)).toBe(true);
  await expectErased(target);
});

it('recovers scheduled deletion after eviction without opening Pi or resurrecting erased state', async () => {
  const { id, actor, headers, url } = await ownedChat();
  expect((await app.request(url, { method: 'DELETE', headers }, env)).status).toBe(202);
  await abortAllDurableObjects();
  const resumed = env.CONVERSATIONS.getByName(actor.runtimeName ?? id);
  await runInDurableObject(resumed, async (_instance, state) => {
    expect(await state.storage.get('deleting')).toBe(true);
    expect(
      state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name LIKE 'pi_%'").toArray(),
    ).toEqual([]);
  });
  expect(await resumed.read(actor, { type: 'snapshot' })).toMatchObject({
    error: { status: 404 },
  });
  expect(await runDurableObjectAlarm(resumed)).toBe(true);
  await expectErased(resumed);
  expect(
    await env.DB.prepare('SELECT lifecycle FROM conversations WHERE id=?')
      .bind(id)
      .first('lifecycle'),
  ).toBe('deleted');
  for (let repeat = 0; repeat < 2; repeat++) {
    await abortAllDurableObjects();
    const fresh = env.CONVERSATIONS.getByName(actor.runtimeName ?? id);
    expect(await fresh.command(actor, { type: 'delete' })).toEqual({ deleting: true });
    await runInDurableObject(fresh, (instance) => instance.alarm());
    expect(await runDurableObjectAlarm(fresh)).toBe(false);
    await expectErased(fresh);
    await runInDurableObject(fresh, async (_instance, state) => {
      expect(
        state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name LIKE 'pi_%'").toArray(),
      ).toEqual([]);
    });
  }
});

it('refuses stale generations and unknown chats before an empty DO creates Pi storage', async () => {
  const { actor, target } = await ownedChat();
  const stale = { ...actor, generation: crypto.randomUUID() };
  expect(await target.read(stale, { type: 'snapshot' })).toMatchObject({ error: { status: 404 } });
  expect(
    await target.command(stale, {
      type: 'submit',
      command: { runId: crypto.randomUUID(), text: 'stale' },
    }),
  ).toMatchObject({ error: { status: 404 } });
  await runInDurableObject(target, async (_instance, state) => {
    expect(await state.storage.get('manifest')).toBeUndefined();
    expect(
      state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name LIKE 'pi_%'").toArray(),
    ).toEqual([]);
  });
  const id = crypto.randomUUID(),
    unknown = env.CONVERSATIONS.getByName(id);
  expect(
    await unknown.read(
      { chatId: id, ownerId: 'a', generation: crypto.randomUUID() },
      { type: 'snapshot' },
    ),
  ).toMatchObject({ error: { status: 404 } });
  await runInDurableObject(unknown, async (_instance, state) => {
    expect(await state.storage.get('manifest')).toBeUndefined();
    expect(
      state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name LIKE 'pi_%'").toArray(),
    ).toEqual([]);
  });
});

it('scopes custom MCP management to the session owner and validates callbacks and bodies', async () => {
  const base = 'http://localhost:5173/api';
  const headers = {
    cookie: await cookie('token-a'),
    origin: env.APP_URL,
    'Content-Type': 'application/json',
  };
  expect((await app.request(base + '/mcp/connections', {}, env)).status).toBe(401);
  const metadata = await app.request(base + '/mcp/client-metadata', {}, env);
  expect(metadata.status).toBe(200);
  expect(await metadata.json()).toMatchObject({ redirect_uris: [base + '/mcp/callback'] });
  expect(
    (
      await app.request(
        base + '/mcp/connections',
        { method: 'POST', headers: { ...headers, origin: 'https://foreign.example' }, body: '{}' },
        env,
      )
    ).status,
  ).toBe(403);
  for (const endpoint of [
    'http://public.example/mcp',
    'https://127.0.0.1/mcp',
    'https://host.internal/mcp',
  ]) {
    const res = await app.request(
      base + '/mcp/connections',
      { method: 'POST', headers, body: JSON.stringify({ name: 'blocked', endpoint }) },
      env,
    );
    expect(res.status).toBe(400);
  }
  const created = await app.request(
    base + '/mcp/connections',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'API ownership',
        endpoint: 'https://public.example/mcp',
        auth: 'none',
      }),
    },
    env,
  );
  expect(created.status).toBe(201);
  const { connection } = (await created.json()) as any;
  expect(
    (
      await app.request(
        base + '/mcp/connections/' + connection.id,
        { method: 'PATCH', headers, body: JSON.stringify({ revision: 999, enabled: false }) },
        env,
      )
    ).status,
  ).toBe(409);
  const other = { ...headers, cookie: await cookie('token-b') };
  const list = await app.request(base + '/mcp/connections', { headers: other }, env);
  expect(await list.json()).toEqual({ connections: [] });
  for (const [method, path, body] of [
    ['POST', '/connect', undefined],
    ['PATCH', '', JSON.stringify({ revision: 1, enabled: false })],
    ['DELETE', '', undefined],
  ] as const) {
    expect(
      (
        await app.request(
          base + '/mcp/connections/' + connection.id + path,
          { method, headers: other, body },
          env,
        )
      ).status,
    ).toBe(404);
  }
  const foreignCallback = await app.request(
    base + '/mcp/callback?state=nonce.' + connection.id + '&code=fixture',
    { headers: other },
    env,
  );
  expect(foreignCallback.headers.get('location')).toBe(env.APP_URL + '/?mcp=error');
  expect(
    (await app.request(base + '/conversations', { method: 'POST', headers, body: '{' }, env))
      .status,
  ).toBe(400);
  expect(
    (
      await app.request(
        base + '/conversations',
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            requestId: crypto.randomUUID(),
            mcpConnectionIds: [connection.id],
          }),
        },
        env,
      )
    ).status,
  ).toBe(201);
  expect(
    (
      await app.request(
        base + '/conversations',
        {
          method: 'POST',
          headers: other,
          body: JSON.stringify({
            requestId: crypto.randomUUID(),
            mcpConnectionIds: [connection.id],
          }),
        },
        env,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await app.request(
        base + '/mcp/connections/' + connection.id,
        { method: 'DELETE', headers },
        env,
      )
    ).status,
  ).toBe(200);
});
