import {
  env,
  applyD1Migrations,
  runInDurableObject,
  abortAllDurableObjects,
} from 'cloudflare:test';
import { beforeAll, it, expect } from 'vitest';
import migration from '../../migrations/0001_auth_and_conversations.sql?raw';
import titleMigration from '../../migrations/0002_custom_conversation_titles.sql?raw';
import { makeSignature } from 'better-auth/crypto';
import app from '../../src/server/index';
const cookie = async (token: string) =>
  'better-auth.session_token=' +
  encodeURIComponent(token + '.' + (await makeSignature(token, env.BETTER_AUTH_SECRET!)));
beforeAll(async () => {
  await applyD1Migrations(env.DB, [
    { name: '0001', queries: migration.split(';').filter((s) => s.trim()) },
    { name: '0002', queries: titleMigration.split(';').filter((s) => s.trim()) },
  ]);
  for (const id of ['a', 'b']) {
    await env.DB.prepare('INSERT INTO user VALUES(?,?,?,1,NULL,?,?)')
      .bind(id, id, id + '@example.com', Date.now(), Date.now())
      .run();
    await env.DB.prepare('INSERT INTO session VALUES(?,?,?,?,?,NULL,NULL,?)')
      .bind(id, Date.now() + 86400000, 'token-' + id, Date.now(), Date.now(), id)
      .run();
  }
});
it('rejects unauthenticated requests with 401', async () =>
  expect((await app.request('http://localhost:5173/api/conversations', {}, env)).status).toBe(401));
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
  expect(await response.json()).toEqual({ extensionIds: ['web', 'openui'] });
});
it('isolates listing and every resource operation using real Better Auth sessions', async () => {
  const a = await cookie('token-a'),
    b = await cookie('token-b');
  const created = await app.request(
    'http://localhost:5173/api/conversations',
    { method: 'POST', headers: { cookie: a, origin: env.APP_URL } },
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
    { method: 'POST', headers },
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
    { method: 'POST', headers },
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
  await env.CONVERSATIONS.getByName(id).stopConversation();
});

it('deletes owned chats only, waits for running tools, withdraws the queue and erases durable content', async () => {
  const headers = { cookie: await cookie('token-a'), origin: env.APP_URL };
  const created = await app.request(
    'http://localhost:5173/api/conversations',
    { method: 'POST', headers },
    env,
  );
  const { id } = (await created.json()) as { id: string };
  const url = `http://localhost:5173/api/conversations/${id}`;
  expect(
    (
      await app.request(
        url,
        { method: 'DELETE', headers: { ...headers, cookie: await cookie('token-b') } },
        env,
      )
    ).status,
  ).toBe(404);
  const target = env.CONVERSATIONS.getByName(id);
  await target.submitRun({ runId: crypto.randomUUID(), text: 'ignores_cancel' });
  for (let i = 0; i < 100; i++) {
    if (JSON.parse(await target.snapshot()).tools.length) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(JSON.parse(await target.snapshot()).tools).toHaveLength(1);
  await target.submitRun({ runId: crypto.randomUUID(), text: 'must not run' });
  await runInDurableObject(target, (_instance, state) => {
    state.storage.sql.exec(
      'INSERT INTO app_inputs VALUES(?,?,1,?)',
      'panel',
      '{"secret":"draft"}',
      Date.now(),
    );
  });
  const deleting = app.request(url, { method: 'DELETE', headers }, env);
  for (let i = 0; i < 100; i++) {
    if (await runInDurableObject(target, (instance) => instance.deleting)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(
    await target.submitRun({ runId: crypto.randomUUID(), text: 'racing submit' }),
  ).toMatchObject({ error: { status: 404 } });
  expect((await deleting).status).toBe(200);
  expect(
    await env.DB.prepare('SELECT id FROM conversations WHERE id=?').bind(id).first(),
  ).toBeNull();
  expect((await app.request(url + '/snapshot', { headers }, env)).status).toBe(404);
  await abortAllDurableObjects();
  const fresh = env.CONVERSATIONS.get(target.id);
  await runInDurableObject(fresh, (_instance, state) => {
    expect(state.storage.sql.exec('SELECT * FROM app_requests').toArray()).toEqual([]);
    expect(state.storage.sql.exec('SELECT * FROM app_inputs').toArray()).toEqual([]);
  });
  expect(JSON.parse(await fresh.snapshot()).entries).toEqual([]);
});

it('resumes a persisted deletion after eviction without restoring a directory entry', async () => {
  const headers = { cookie: await cookie('token-a'), origin: env.APP_URL };
  const created = await app.request(
    'http://localhost:5173/api/conversations',
    { method: 'POST', headers },
    env,
  );
  const { id } = (await created.json()) as { id: string };
  const target = env.CONVERSATIONS.getByName(id);
  await runInDurableObject(target, (_instance, state) => {
    state.storage.sql.exec('INSERT INTO app_meta(key,value) VALUES(?,?)', 'deleting', id);
  });
  await abortAllDurableObjects();
  for (let i = 0; i < 150; i++) {
    // Wake the same object while retaining SQLite, as an alarm or retried request would.
    await env.CONVERSATIONS.get(target.id).snapshot();
    if (!(await env.DB.prepare('SELECT id FROM conversations WHERE id=?').bind(id).first())) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Deletion did not recover');
});
