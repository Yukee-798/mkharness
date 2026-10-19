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
        queries: (() => {
          const sql = text as string;
          const triggers = [...sql.matchAll(/CREATE TRIGGER[\s\S]*?END;/g)].map(
            (match) => match[0],
          );
          let rest = sql;
          for (const trigger of triggers) rest = rest.replace(trigger, '');
          return [...rest.split(';').filter((query) => query.trim()), ...triggers];
        })(),
      })),
  );
});
