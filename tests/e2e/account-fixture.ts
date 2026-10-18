import { execFileSync } from 'node:child_process';
import { makeSignature } from 'better-auth/crypto';
import type { BrowserContext } from '@playwright/test';

export const e2eAuthSecret = 'local-test-only-secret-at-least-32-chars';
/** Seed only the isolated local E2E database; production has no test login route. */
export async function seedAccount(context: BrowserContext) {
  const id = crypto.randomUUID(),
    token = crypto.randomUUID(),
    now = Date.now();
  const sql = [
    `INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES('${id}','Test account','${id}@example.test',1,${now},${now})`,
    `INSERT INTO account(id,accountId,providerId,userId,createdAt,updatedAt) VALUES('${id}','${id}','google','${id}',${now},${now})`,
    `INSERT INTO session VALUES('${id}',${now + 86400000},'${token}',${now},${now},NULL,NULL,'${id}')`,
  ].join(';');
  execFileSync(
    process.execPath,
    [
      'node_modules/wrangler/bin/wrangler.js',
      'd1',
      'execute',
      'DB',
      '--config',
      'tests/e2e/worker.jsonc',
      '--local',
      '--persist-to',
      '.wrangler/native-e2e-state',
      '--command',
      sql,
    ],
    { stdio: 'pipe', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
  );
  await context.addCookies([
    {
      name: 'better-auth.session_token',
      value: token + '.' + (await makeSignature(token, e2eAuthSecret)),
      url: 'http://localhost:5174',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
}
