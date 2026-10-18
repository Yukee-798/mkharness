import { expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import baseline from '../../migrations/0001_initial.sql?raw';
import accounts from '../../migrations/0002_google_accounts.sql?raw';

it('revokes retired browser sessions while preserving account sessions, users and owned data', async () => {
  for (const sql of baseline.split(';').filter((sql) => sql.trim()))
    await env.DB.prepare(sql).run();
  for (const [id, retired] of [
    ['browser', 1],
    ['google', 0],
  ] as const) {
    await env.DB.prepare(
      'INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt,isAnonymous) VALUES(?,?,?,1,1,1,?)',
    )
      .bind(id, id, id + '@example.test', retired)
      .run();
    await env.DB.prepare('INSERT INTO session VALUES(?,9999999999999,?,1,1,NULL,NULL,?)')
      .bind(id, 'token-' + id, id)
      .run();
    await env.DB.prepare(
      'INSERT INTO conversations(id,owner,create_request_id,create_hash,instance_generation,title,created_at,updated_at) VALUES(?,?,?,?,?,?,1,1)',
    )
      .bind(id, id, id, 'hash', 'generation', 'Saved chat')
      .run();
  }
  for (const sql of accounts.split(';').filter((sql) => sql.trim()))
    await env.DB.prepare(sql).run();
  expect((await env.DB.prepare('SELECT id FROM session ORDER BY id').all()).results).toEqual([
    { id: 'google' },
  ]);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM user').first('n')).toBe(2);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM conversations').first('n')).toBe(2);
  const { results } = await env.DB.prepare("SELECT name FROM pragma_table_info('user')").all();
  expect(results.map((row) => row.name)).not.toContain('isAnonymous');
});
