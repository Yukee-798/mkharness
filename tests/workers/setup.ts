import { beforeAll } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
const migrations = import.meta.glob('../../migrations/*.sql', {
  eager: true,
  query: '?raw',
  import: 'default',
});
beforeAll(async () => {
  await applyD1Migrations(
    env.DB,
    Object.entries(migrations)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, text]) => ({
        name: name.split('/').at(-1)!,
        queries: (text as string).split(';').filter((query) => query.trim()),
      })),
  );
});
