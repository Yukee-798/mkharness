import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
/** Fill only missing local secrets. Never rotate keys on startup or disclose their values. */
export function setupLocalSecrets(path = resolve('.dev.vars')) {
  let contents = existsSync(path) ? readFileSync(path, 'utf8') : '';
  for (const name of ['BETTER_AUTH_SECRET', 'CREDENTIAL_ENCRYPTION_KEY']) {
    const line = new RegExp('^[\\t ]*(?:export[\\t ]+)?' + name + '[\\t ]*=[\\t ]*(.*)$', 'gm');
    const match = [...contents.matchAll(line)].at(-1);
    const raw = match?.[1].trim() ?? '';
    const value =
      raw.startsWith('"') || raw.startsWith("'")
        ? raw.slice(1, raw.lastIndexOf(raw[0]) > 0 ? raw.lastIndexOf(raw[0]) : undefined)
        : raw.split('#')[0].trim();
    if (value) continue;
    const replacement = name + '=' + randomBytes(32).toString('base64');
    contents = match
      ? contents.slice(0, match.index) + replacement + contents.slice(match.index + match[0].length)
      : contents + (contents && !contents.endsWith('\n') ? '\n' : '') + replacement + '\n';
  }
  writeFileSync(path, contents, { mode: 0o600 });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setupLocalSecrets();
  console.log('Local secrets are configured in .dev.vars. Existing values were preserved.');
}
