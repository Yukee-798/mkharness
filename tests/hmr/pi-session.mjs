import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { openuiServerCatalog } from '../../config/openui-catalog.ts';

process.env.X_LOCAL_OBSERVABILITY = 'false';
const persistence = await realpath(await mkdtemp(join(tmpdir(), 'pi-hmr-')));
// Do not mutate repository files watched by another running dev server.
const file = join(persistence, 'worker.ts');
const original = (await readFile(new URL('./worker.ts', import.meta.url), 'utf8'))
  .replace(
    '../../src/server/conversation',
    fileURLToPath(new URL('../../src/server/conversation', import.meta.url)),
  )
  .replace('../fixture-model', fileURLToPath(new URL('../fixture-model', import.meta.url)));
const dependency = join(persistence, 'revision.ts');
const originalDependency = await readFile(new URL('./revision.ts', import.meta.url), 'utf8');
const clientFile = join(persistence, 'client.ts');
const originalClient = await readFile(new URL('./client.ts', import.meta.url), 'utf8');
await writeFile(file, original);
await writeFile(dependency, originalDependency);
await writeFile(clientFile, originalClient);
await writeFile(
  join(persistence, 'wrangler.jsonc'),
  await readFile(new URL('./wrangler.jsonc', import.meta.url)),
);
await symlink(
  fileURLToPath(new URL('../../node_modules', import.meta.url)),
  join(persistence, 'node_modules'),
  'dir',
);
// Match the application's build seam; the real extensions import this metadata.
const plugins = [openuiServerCatalog()];
let restart;
plugins.push({
  name: 'observe-test-restarts',
  configureServer(server) {
    const restartServer = server.restart.bind(server);
    server.restart = (...args) => (restart = restartServer(...args));
  },
});
if (!process.argv.includes('--unfixed')) {
  const { durableReload } = await import('../../config/durable-reload.ts');
  plugins.push(durableReload(file));
}
plugins.push(
  cloudflare({
    configPath: join(persistence, 'wrangler.jsonc'),
    persistState: { path: join(persistence, 'storage') },
  }),
);
const server = await createServer({
  configFile: false,
  root: persistence,
  cacheDir: join(persistence, 'vite-cache'),
  plugins,
  resolve: { alias: { '@': fileURLToPath(new URL('../../src', import.meta.url)) } },
  server: { host: '127.0.0.1', port: 5187, strictPort: true },
});
try {
  await server.listen();
  const probe = async () => {
    const response = await fetch('http://127.0.0.1:5187');
    assert.equal(response.status, 200);
    return response.json();
  };
  const initial = await Promise.all(Array.from({ length: 8 }, probe));
  assert(initial.every((items) => items.length === 1));
  console.log('Concurrent requests: one Pi runtime.');
  await writeFile(file, original + '\n// HMR regression trigger\n');
  await new Promise((resolve) => setTimeout(resolve, 2500));
  if (restart) await restart;
  const after = await probe();
  console.log('After server module change:', JSON.stringify(after));
  assert.equal(
    after.length,
    1,
    'HMR must not keep an old Pi runtime alive alongside its replacement',
  );
  assert.equal(after[0].marker, initial[0][0].marker, 'Worker restart must preserve SQLite');
  if (!process.argv.includes('--unfixed')) {
    restart = undefined;
    await writeFile(dependency, originalDependency.replace('= 1', '= 2'));
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert(restart, 'Changes to a DO dependency must restart workerd');
    await restart;
    const dependencyResult = await probe();
    assert.equal(dependencyResult.length, 1);
    assert.equal(dependencyResult[0].revision, 2);
    assert.equal(dependencyResult[0].marker, initial[0][0].marker);
    restart = undefined;
    await server.environments.client.transformRequest('/client.ts');
    await writeFile(clientFile, originalClient.replace('= 1', '= 2'));
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(restart, undefined, 'Client-only HMR must not restart the Worker');
    assert.equal((await probe())[0].id, dependencyResult[0].id);
    console.log('DO dependency restart, SQLite retention and client-only HMR: passed.');
  }
} finally {
  await server.watcher.unwatch([file, dependency, clientFile]);
  try {
    await server.close();
  } finally {
    await rm(persistence, { recursive: true, force: true });
  }
}
