import { env, runInDurableObject, abortAllDurableObjects } from 'cloudflare:test';
import { beforeAll, it, expect, vi } from 'vitest';
import { makeSignature } from 'better-auth/crypto';
import app from '../../src/server/index';
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
  expect(await response.json()).toEqual({ extensionIds: ['timing', 'web', 'openui', 'reply'] });
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
    ['runs/abc/queue', 'POST'],
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

it('accepts empty-chat deletion without running destructive teardown inside the RPC', async () => {
  const headers = { cookie: await cookie('token-a'), origin: env.APP_URL };
  const created = await app.request(
    'http://localhost:5173/api/conversations',
    { method: 'POST', headers },
    env,
  );
  const { id } = (await created.json()) as { id: string };
  const target = env.CONVERSATIONS.getByName(id);
  let destroyed = false;
  await runInDurableObject(target, (instance) => {
    const destroy = instance.destroy.bind(instance);
    instance.destroy = async () => {
      destroyed = true;
      await destroy();
    };
  });
  const response = await app.request(
    `http://localhost:5173/api/conversations/${id}`,
    { method: 'DELETE', headers },
    env,
  );
  // Workerd may deliver a reply before ctx.abort; production consistently loses it.
  // Lock down the cause rather than depend on the local RPC-abort timing.
  expect(destroyed).toBe(false);
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ deleting: true });
  expect(
    await env.DB.prepare('SELECT id FROM conversations WHERE id=?').bind(id).first(),
  ).toBeNull();
  await runInDurableObject(target, async (instance) => {
    // A late observer or model-preparation callback cannot start another runtime.
    await expect(instance.harness.pi()).rejects.toMatchObject({ code: 'not_found' });
  });
  await vi.waitFor(() => expect(destroyed).toBe(true), { timeout: 5000, interval: 20 });
});

it('deletes owned chats only, stops running work and erases durable content', async () => {
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
  let erased = false;
  await runInDurableObject(target, (_instance, state) => {
    const deleteAll = state.storage.deleteAll.bind(state.storage);
    state.storage.deleteAll = async () => {
      await deleteAll();
      erased = true;
    };
  });
  const deleting = app.request(url, { method: 'DELETE', headers }, env);
  for (let i = 0; i < 100; i++) {
    if (await runInDurableObject(target, (instance) => instance.deleting)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(
    await target.submitRun({ runId: crypto.randomUUID(), text: 'racing submit' }),
  ).toMatchObject({ error: { status: 404 } });
  const response = await deleting;
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ deleting: true });
  expect(
    await env.DB.prepare('SELECT id FROM conversations WHERE id=?').bind(id).first(),
  ).toBeNull();
  expect((await app.request(url + '/snapshot', { headers }, env)).status).toBe(404);
  await vi.waitFor(() => expect(erased).toBe(true), { timeout: 5000, interval: 20 });
  await abortAllDurableObjects();
  const fresh = env.CONVERSATIONS.get(target.id);
  await runInDurableObject(fresh, (_instance, state) => {
    expect(state.storage.sql.exec('SELECT * FROM app_requests').toArray()).toEqual([]);
    expect(state.storage.sql.exec('SELECT * FROM app_inputs').toArray()).toEqual([]);
  });
  expect(JSON.parse(await fresh.snapshot()).entries).toEqual([]);
});

it('retains failed cleanup after native retry exhaustion until teardown can succeed', async () => {
  const headers = { cookie: await cookie('token-a'), origin: env.APP_URL };
  const created = await app.request(
    'http://localhost:5173/api/conversations',
    { method: 'POST', headers },
    env,
  );
  const { id } = (await created.json()) as { id: string };
  const target = env.CONVERSATIONS.getByName(id);
  let attempts = 0;
  let restore = () => {};
  let erased = false;
  await runInDurableObject(target, (instance, state) => {
    const spy = vi.spyOn(instance, 'destroy').mockImplementation(async () => {
      attempts++;
      throw new Error('fixture cleanup unavailable');
    });
    restore = () => spy.mockRestore();
    const deleteAll = state.storage.deleteAll.bind(state.storage);
    state.storage.deleteAll = async () => {
      await deleteAll();
      erased = true;
    };
  });
  expect(
    (
      await app.request(
        `http://localhost:5173/api/conversations/${id}`,
        { method: 'DELETE', headers },
        env,
      )
    ).status,
  ).toBe(202);
  await vi.waitFor(
    async () => {
      expect(attempts).toBe(3);
      await runInDurableObject(target, (_instance, state) => {
        const job = state.storage.sql
          .exec("SELECT time,running FROM cf_agents_jobs WHERE capability='app-requests'")
          .one();
        expect(job.running).toBe(0);
        expect(Number(job.time)).toBeGreaterThan(Date.now() + 30_000);
        expect(
          state.storage.sql.exec("SELECT value FROM app_meta WHERE key='deleting'").one().value,
        ).toBe(id);
      });
    },
    { timeout: 5000, interval: 20 },
  );
  expect(erased).toBe(false);
  expect(
    await env.DB.prepare('SELECT id FROM conversations WHERE id=?').bind(id).first(),
  ).toBeNull();
  restore();
  // Bring the persisted deadline forward in this fixture, rather than wait a minute.
  await runInDurableObject(target, async (instance, state) => {
    state.storage.sql.exec(
      "UPDATE cf_agents_jobs SET time=? WHERE capability='app-requests'",
      Date.now() + 100,
    );
    await instance.lifecycle.rearmAlarm();
  });
  await vi.waitFor(() => expect(erased).toBe(true), { timeout: 5000, interval: 20 });
});

for (const scheduled of [false, true]) {
  it(`recovers ${scheduled ? 'scheduled' : 'interrupted admission of'} deletion after eviction without reopening Pi`, async () => {
    const headers = { cookie: await cookie('token-a'), origin: env.APP_URL };
    const created = await app.request(
      'http://localhost:5173/api/conversations',
      { method: 'POST', headers },
      env,
    );
    const { id } = (await created.json()) as { id: string };
    const target = env.CONVERSATIONS.getByName(id);
    if (scheduled) await target.deleteConversation(id);
    else
      await runInDurableObject(target, (_instance, state) => {
        state.storage.sql.exec('INSERT INTO app_meta(key,value) VALUES(?,?)', 'deleting', id);
      });
    const deadline = scheduled
      ? await runInDurableObject(
          target,
          (_instance, state) =>
            state.storage.sql
              .exec("SELECT time FROM cf_agents_jobs WHERE capability='app-requests'")
              .one().time,
        )
      : undefined;
    await abortAllDurableObjects();
    const resumed = env.CONVERSATIONS.get(target.id);
    let erased = false;
    await runInDurableObject(resumed, (instance, state) => {
      expect(instance.deleting).toBe(true);
      if (scheduled)
        expect(
          state.storage.sql
            .exec("SELECT time FROM cf_agents_jobs WHERE capability='app-requests'")
            .one().time,
        ).toBe(deadline);
      vi.spyOn(instance.harness, 'pi').mockImplementation(() => {
        throw new Error('Deleting recovery must not open a runtime');
      });
      const deleteAll = state.storage.deleteAll.bind(state.storage);
      state.storage.deleteAll = async () => {
        await deleteAll();
        erased = true;
      };
    });
    expect(JSON.parse(await resumed.snapshot())).toMatchObject({ error: { code: 'not_found' } });
    await vi.waitFor(() => expect(erased).toBe(true), { timeout: 5000, interval: 20 });
    expect(
      await env.DB.prepare('SELECT id FROM conversations WHERE id=?').bind(id).first(),
    ).toBeNull();
    expect(
      (
        await app.request(
          `http://localhost:5173/api/conversations/${id}/snapshot`,
          { headers },
          env,
        )
      ).status,
    ).toBe(404);
    await abortAllDurableObjects();
    const fresh = env.CONVERSATIONS.get(target.id);
    await runInDurableObject(fresh, (_instance, state) => {
      expect(state.storage.sql.exec('SELECT * FROM app_meta').toArray()).toEqual([]);
      expect(state.storage.sql.exec('SELECT * FROM app_requests').toArray()).toEqual([]);
    });
    expect(JSON.parse(await fresh.snapshot()).entries).toEqual([]);
  });
}
