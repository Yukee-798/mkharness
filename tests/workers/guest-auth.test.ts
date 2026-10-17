import { env } from './env';
import { expect, it } from 'vitest';
import app from '../../src/server/index';

const guestEnv = () => ({
  ...env,
  AUTH_MODE: 'guest',
  GOOGLE_CLIENT_ID: '',
  GOOGLE_CLIENT_SECRET: '',
});
const origin = 'http://localhost:5173';
async function enter() {
  const response = await app.request(
    origin + '/api/auth/sign-in/anonymous',
    {
      method: 'POST',
      headers: { origin, 'Content-Type': 'application/json' },
      body: '{}',
    },
    guestEnv(),
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.get('set-cookie')?.match(/better-auth\.session_token=[^;]+/)?.[0];
  expect(cookie).toBeTruthy();
  return { cookie: cookie!, result: (await response.json()) as any };
}

it('reads guest bootstrap without Google, creating identities, or acquiring a DO', async () => {
  const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM user').first<number>('n');
  const response = await app.request(origin + '/api/bootstrap', {}, {
    ...guestEnv(),
    CONVERSATIONS: {
      getByName() {
        throw new Error('read acquired DO');
      },
    },
  } as any);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ authMode: 'guest' });
  expect(response.headers.get('Cache-Control')).toContain('no-store');
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM user').first('n')).toBe(before);
  expect((await app.request(origin + '/api/conversations', {}, guestEnv())).status).toBe(401);
});

it('creates separate native anonymous owners and denies cross-owner access', async () => {
  const a = await enter(),
    b = await enter();
  expect(a.result.user.isAnonymous).toBe(true);
  expect(a.result.user.id).not.toBe(b.result.user.id);
  const created = await app.request(
    origin + '/api/conversations',
    {
      method: 'POST',
      headers: { origin, cookie: a.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: crypto.randomUUID() }),
    },
    guestEnv(),
  );
  expect(created.status).toBe(201);
  const { id } = (await created.json()) as { id: string };
  const forbidden = await app.request(
    origin + `/api/conversations/${id}/snapshot`,
    {
      headers: { cookie: b.cookie },
    },
    guestEnv(),
  );
  expect(forbidden.status).toBe(404);
  const reused = await app.request(
    origin + '/api/auth/get-session',
    { headers: { cookie: a.cookie } },
    guestEnv(),
  );
  expect(((await reused.json()) as any).user.id).toBe(a.result.user.id);
});

it('disables anonymous deletion and rejects identities from the other deployment mode', async () => {
  const a = await enter();
  const deleted = await app.request(
    origin + '/api/auth/delete-anonymous-user',
    {
      method: 'POST',
      headers: { origin, cookie: a.cookie, 'Content-Type': 'application/json' },
      body: '{}',
    },
    guestEnv(),
  );
  expect(deleted.status).toBe(400);
  expect(
    await env.DB.prepare('SELECT id FROM user WHERE id=?').bind(a.result.user.id).first(),
  ).not.toBeNull();
  const mismatch = await app.request(
    origin + '/api/conversations',
    { headers: { cookie: a.cookie } },
    {
      ...env,
      AUTH_MODE: 'account',
    },
  );
  expect(mismatch.status).toBe(409);
  expect(await mismatch.json()).toMatchObject({ error: { code: 'auth_mode_mismatch' } });
});

it('requires Google only in account mode and rejects an invalid deployment mode', async () => {
  const account = await app.request(
    origin + '/api/auth/get-session',
    {},
    {
      ...env,
      AUTH_MODE: 'account',
      GOOGLE_CLIENT_ID: '',
    },
  );
  expect(account.status).toBe(503);
  const invalid = await app.request(
    origin + '/api/bootstrap',
    {},
    { ...env, AUTH_MODE: 'invalid' },
  );
  expect(invalid.status).toBe(503);
  expect(await invalid.json()).toMatchObject({ error: { code: 'invalid_auth_mode' } });
});
