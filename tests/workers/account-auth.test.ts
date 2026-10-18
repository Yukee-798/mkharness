import { env } from './env';
import { expect, it } from 'vitest';
import app from '../../src/server/index';
import { accountSession } from './account-session';
const origin = 'http://localhost:5173';
it('does not expose anonymous identity creation or deletion', async () => {
  const before = await env.DB.prepare('SELECT COUNT(*) n FROM user').first('n');
  for (const path of ['sign-in/anonymous', 'delete-anonymous-user']) {
    const response = await app.request(
      `${origin}/api/auth/${path}`,
      {
        method: 'POST',
        headers: { origin, 'Content-Type': 'application/json' },
        body: '{}',
      },
      env,
    );
    expect(response.status).toBe(404);
  }
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM user').first('n')).toBe(before);
  expect((await app.request(origin + '/api/conversations', {}, env)).status).toBe(401);
});
it('restores account sessions and isolates account-owned data', async () => {
  const a = await accountSession(),
    b = await accountSession();
  const session = await app.request(
    origin + '/api/auth/get-session',
    { headers: { cookie: a } },
    env,
  );
  expect(session.status).toBe(200);
  const body = (await session.json()) as { user: { id: string } };
  expect(body.user).not.toHaveProperty('isAnonymous');
  const created = await app.request(
    origin + '/api/conversations',
    {
      method: 'POST',
      headers: { origin, cookie: a },
      body: JSON.stringify({ requestId: crypto.randomUUID() }),
    },
    env,
  );
  expect(created.status).toBe(201);
  const { id } = (await created.json()) as { id: string };
  expect(
    (
      await app.request(
        `${origin}/api/conversations/${id}/snapshot`,
        { headers: { cookie: b } },
        env,
      )
    ).status,
  ).toBe(404);
});
it('requires Google credentials in every environment and returns a Google OAuth URL', async () => {
  const missing = await app.request(
    origin + '/api/auth/get-session',
    {},
    { ...env, GOOGLE_CLIENT_ID: '' },
  );
  expect(missing.status).toBe(503);
  expect(await missing.json()).toMatchObject({ code: 'auth_not_configured' });
  const login = await app.request(
    origin + '/api/auth/sign-in/social',
    {
      method: 'POST',
      headers: { origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'google', callbackURL: origin, disableRedirect: true }),
    },
    env,
  );
  expect(login.status).toBe(200);
  const url = new URL(((await login.json()) as { url: string }).url);
  expect(url.hostname).toBe('accounts.google.com');
  expect(url.searchParams.get('redirect_uri')).toBe(`${origin}/api/auth/callback/google`);
});
