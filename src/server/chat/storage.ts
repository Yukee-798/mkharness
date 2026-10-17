import { AsyncLocalStorage } from 'node:async_hooks';
import type { Storage, StorageWrite } from '@earendil-works/pi-durable';
import {
  SqliteStorage,
  type SqliteDatabase,
  type SqliteExecutor,
} from '@earendil-works/pi-durable/storage/sqlite';
import { DurableObjectSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/cloudflare';
import { ConversationFactsIndex } from './facts-index';

/** Native storage and its derived locators commit through the same public SQL transaction. */
export async function openChatStorage(host: DurableObjectStorage) {
  const base = new DurableObjectSqliteDatabase(host);
  await base.exec(`
    CREATE TABLE IF NOT EXISTS app_read_meta (singleton INTEGER PRIMARY KEY,revision INTEGER NOT NULL);
    INSERT INTO app_read_meta VALUES(1,0) ON CONFLICT DO NOTHING;
    CREATE TABLE IF NOT EXISTS app_read_tasks(id INTEGER PRIMARY KEY,conversation_id INTEGER NOT NULL,assistant INTEGER,status TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS app_tasks_page ON app_read_tasks(conversation_id,assistant);
    CREATE INDEX IF NOT EXISTS app_tasks_status ON app_read_tasks(conversation_id,status);
    CREATE TABLE IF NOT EXISTS app_read_submissions(id INTEGER PRIMARY KEY,conversation_id INTEGER NOT NULL,entry INTEGER,answer INTEGER,status TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS app_submissions_entry ON app_read_submissions(conversation_id,entry);
    CREATE INDEX IF NOT EXISTS app_submissions_answer ON app_read_submissions(conversation_id,answer);
    CREATE INDEX IF NOT EXISTS app_submissions_status ON app_read_submissions(conversation_id,status);
  `);
  const commits = new AsyncLocalStorage<readonly StorageWrite[]>();
  const database: SqliteDatabase = {
    exec: base.exec.bind(base),
    run: base.run.bind(base),
    get: base.get.bind(base),
    all: base.all.bind(base),
    close: base.close.bind(base),
    transaction<T>(callback: (tx: SqliteExecutor) => Promise<T>): Promise<T> {
      const writes = commits.getStore();
      return base.transaction(async (tx) => {
        const result = await callback(tx);
        if (writes) await indexWrites(tx, writes, Number(result));
        return result;
      });
    },
  };
  const native = await SqliteStorage.open(database, { prefix: 'pi_' });
  const storage = new Proxy(native, {
    get(target, key) {
      if (key === 'commit')
        return ((writes, context) =>
          commits.run(writes, () => target.commit(writes, context))) satisfies Storage['commit'];
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { storage, database, index: new ConversationFactsIndex(database, storage) };
}

async function indexWrites(tx: SqliteExecutor, writes: readonly StorageWrite[], revision: number) {
  for (const write of writes) {
    if (write.type === 'task') {
      const task = write.value;
      const input = task.input;
      const assistant =
        input &&
        typeof input === 'object' &&
        !Array.isArray(input) &&
        typeof input.assistant === 'number'
          ? input.assistant
          : null;
      await tx.run(
        'INSERT INTO app_read_tasks(id,conversation_id,assistant,status) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET conversation_id=excluded.conversation_id,assistant=excluded.assistant,status=excluded.status',
        Number(task.id),
        Number(task.conversationId),
        assistant,
        task.state.status,
      );
    } else if (write.type === 'submission') {
      const item = write.value;
      await tx.run(
        'INSERT INTO app_read_submissions(id,conversation_id,entry,answer,status) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET conversation_id=excluded.conversation_id,entry=excluded.entry,answer=excluded.answer,status=excluded.status',
        Number(item.id),
        Number(item.conversationId),
        'entry' in item ? Number(item.entry) || null : null,
        'answer' in item ? Number(item.answer) || null : null,
        item.status,
      );
    }
  }
  await tx.run('UPDATE app_read_meta SET revision=? WHERE singleton=1', revision);
}
