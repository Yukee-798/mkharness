import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const localStatePath = '.wrangler/native-state';
const nativeMigrations = ['0001_initial.sql', '0002_google_accounts.sql'];
const directoryColumns = ['create_request_id', 'create_hash', 'instance_generation', 'lifecycle'];
const baselineTables = [
  'user',
  'session',
  'account',
  'verification',
  'conversations',
  'model_credentials',
  'mcp_connections',
  'conversation_mcp_bindings',
  'conversation_deployment_mcp_bindings',
  'skills',
  'skill_versions',
  'conversation_skill_bindings',
];

function localWrangler(args, root) {
  const entry = fileURLToPath(new URL('../bin/wrangler.js', import.meta.resolve('wrangler')));
  return execFileSync(
    process.execPath,
    [
      entry,
      ...args,
      '--config',
      resolve(root, 'wrangler.jsonc'),
      '--env',
      '',
      '--local',
      '--persist-to',
      resolve(root, localStatePath),
    ],
    {
      cwd: root,
      env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

function queryLocalDatabase(command, root) {
  const results = JSON.parse(
    localWrangler(['d1', 'execute', 'DB', '--command', command, '--json'], root),
  );
  if (!results.every((result) => result.success)) throw new Error('Local D1 preflight failed.');
  return results.flatMap((result) => result.results);
}

/** Accept empty storage or the known native migration chain, never a legacy import. */
export function checkLocalBaseline(root = projectRoot) {
  const migrations = readdirSync(resolve(root, 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  if (JSON.stringify(migrations) !== JSON.stringify(nativeMigrations)) {
    throw new Error(
      'Native Pi setup requires the known migrations/0001_initial.sql + 0002_google_accounts.sql chain.',
    );
  }
  const tables = queryLocalDatabase(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
    root,
  ).map((row) => row.name);
  if (!tables.length) return 'empty';
  const migrationsApplied = tables.includes('d1_migrations')
    ? queryLocalDatabase('SELECT name FROM d1_migrations ORDER BY id', root).map((row) => row.name)
    : [];
  if (tables.every((name) => name === 'd1_migrations') && !migrationsApplied.length) return 'empty';
  const columns = tables.includes('conversations')
    ? queryLocalDatabase("SELECT name FROM pragma_table_info('conversations')", root).map(
        (row) => row.name,
      )
    : [];
  if (
    !migrationsApplied.length ||
    migrationsApplied.length > nativeMigrations.length ||
    migrationsApplied.some((name, index) => name !== nativeMigrations[index]) ||
    !baselineTables.every((name) => tables.includes(name)) ||
    !directoryColumns.every((name) => columns.includes(name))
  ) {
    throw new Error(
      'This local D1 database is not the native Pi baseline. Use a new empty database and ' +
        localStatePath +
        '; existing accounts, chats and connections are not migrated.',
    );
  }
  return migrationsApplied.length === nativeMigrations.length ? 'ready' : 'pending';
}

export function setupLocalDatabase(root = projectRoot) {
  const state = checkLocalBaseline(root);
  if (state !== 'ready') localWrangler(['d1', 'migrations', 'apply', 'DB'], root);
  if (checkLocalBaseline(root) !== 'ready')
    throw new Error('The native Pi baseline was not applied.');
}

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
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== '--check') || args.length > 1) {
      throw new Error(
        'Usage: node scripts/setup.mjs [--check]. Setup operates on local native state only.',
      );
    }
    const state = checkLocalBaseline();
    if (args.includes('--check')) {
      console.log('Native Pi local baseline: ' + state + ' (' + localStatePath + ').');
    } else {
      setupLocalSecrets(resolve(projectRoot, '.dev.vars'));
      setupLocalDatabase();
      console.log('Local secrets are configured in .dev.vars. Existing values were preserved.');
      console.log('Native Pi local baseline is ready in ' + localStatePath + '.');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
