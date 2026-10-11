import type { Storage, DocumentRecord } from '@earendil-works/pi-durable';

const context: Parameters<Storage['close']>[0] = {
  abortSignal: undefined,
  value: () => undefined,
  toString: () => '[Pi storage validation]',
};

export class RuntimeStorageError extends Error {
  constructor(
    readonly code: 'runtime_superseded' | 'runtime_storage_invalid',
    readonly documentId?: number,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = 'RuntimeStorageError';
  }
}

/** One mutable Pi Session may own a Durable Object's document tracker cache. */
export function claimPiStorage(
  storage: Storage,
  host: DurableObjectStorage,
  onLost: () => void = () => {},
): Storage {
  const owner = crypto.randomUUID();
  host.sql.exec(
    'INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    'pi_runtime_owner',
    owner,
  );
  let lost = false;
  const commit: Storage['commit'] = (writes, context) =>
    host.transaction(async () => {
      // The check and native commit share the same storage transaction. A replacement
      // runtime may read the old state, but the displaced tracker cannot write afterward.
      if (
        lost ||
        host.sql.exec('SELECT value FROM app_meta WHERE key=?', 'pi_runtime_owner').toArray()[0]
          ?.value !== owner
      ) {
        if (!lost) {
          lost = true;
          queueMicrotask(onLost);
        }
        throw new RuntimeStorageError('runtime_superseded');
      }
      return storage.commit(writes, context);
    });
  return new Proxy(storage, {
    get(target, key) {
      if (key === 'commit') return commit;
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Restore before enabling scheduling, so invalid data cannot enter Pi's retry loop. */
export async function validatePiStorage(storage: Storage): Promise<void> {
  const scopes: DocumentRecord['scope'][] = [{ kind: 'session' }];
  let cursor;
  do {
    const page = await storage.scanConversations({}, 100, cursor, context);
    scopes.push(
      ...page.items.map((record) => ({ kind: 'conversation' as const, conversationId: record.id })),
    );
    cursor = page.next;
  } while (cursor);
  for (const status of ['pending', 'running', 'waiting', 'completing'] as const) {
    cursor = undefined;
    do {
      const page = await storage.scanTasks({ status }, 100, cursor, context);
      scopes.push(...page.items.map((record) => ({ kind: 'task' as const, taskId: record.id })));
      cursor = page.next;
    } while (cursor);
  }
  for (const scope of scopes) {
    cursor = undefined;
    do {
      const page = await storage.scanDocuments({ scope, at: 'current' }, 100, cursor, context);
      for (const record of page.items) {
        try {
          await storage.document(record.id, 'current', context);
        } catch (cause) {
          throw new RuntimeStorageError('runtime_storage_invalid', Number(record.id), { cause });
        }
      }
      cursor = page.next;
    } while (cursor);
  }
}
