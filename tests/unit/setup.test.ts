import { it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupLocalSecrets } from '../../scripts/setup.mjs';
it('fills missing local secrets once, without rotating existing identity or credential keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mkharness-setup-')),
    path = join(dir, '.dev.vars');
  try {
    writeFileSync(
      path,
      '# retained\nBETTER_AUTH_SECRET=existing-secret\nCREDENTIAL_ENCRYPTION_KEY=\nMODEL_API_KEY=untouched\n',
    );
    setupLocalSecrets(path);
    const first = readFileSync(path, 'utf8');
    expect(first).toContain('BETTER_AUTH_SECRET=existing-secret');
    expect(first).toContain('MODEL_API_KEY=untouched');
    expect(first).toContain('# retained');
    expect(
      Buffer.from(first.match(/^CREDENTIAL_ENCRYPTION_KEY=(.*)$/m)![1], 'base64'),
    ).toHaveLength(32);
    setupLocalSecrets(path);
    expect(readFileSync(path, 'utf8')).toBe(first);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
it.each([
  ' export CREDENTIAL_ENCRYPTION_KEY = "kept-master" # comment',
  '  CREDENTIAL_ENCRYPTION_KEY = kept-master',
  'CREDENTIAL_ENCRYPTION_KEY=old\nexport CREDENTIAL_ENCRYPTION_KEY=kept-master',
])('preserves valid dotenv assignments: %s', (line) => {
  const dir = mkdtempSync(join(tmpdir(), 'mkharness-setup-')),
    path = join(dir, '.dev.vars');
  try {
    const before = 'export BETTER_AUTH_SECRET = kept-auth\n' + line + '\n';
    writeFileSync(path, before);
    setupLocalSecrets(path);
    expect(readFileSync(path, 'utf8')).toBe(before);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
