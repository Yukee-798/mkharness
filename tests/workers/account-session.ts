import { makeSignature } from 'better-auth/crypto';
import { env } from './env';

/** Real persisted account/session fixtures; no test-only sign-in endpoint. */
export async function accountSession() {
  const id = crypto.randomUUID(),
    token = crypto.randomUUID(),
    now = Date.now();
  await env.DB.prepare(
    'INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)',
  )
    .bind(id, 'Account', `${id}@example.test`, now, now)
    .run();
  await env.DB.prepare(
    'INSERT INTO account(id,accountId,providerId,userId,createdAt,updatedAt) VALUES(?,?,?,?,?,?)',
  )
    .bind(crypto.randomUUID(), id, 'google', id, now, now)
    .run();
  await env.DB.prepare('INSERT INTO session VALUES(?,?,?,?,?,NULL,NULL,?)')
    .bind(crypto.randomUUID(), now + 86400000, token, now, now, id)
    .run();
  return (
    'better-auth.session_token=' +
    encodeURIComponent(token + '.' + (await makeSignature(token, env.BETTER_AUTH_SECRET!)))
  );
}
