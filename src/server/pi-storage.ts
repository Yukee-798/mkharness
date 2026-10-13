import type { Storage } from '@earendil-works/pi-durable';

export class RuntimeStorageError extends Error {
  constructor(readonly code: 'runtime_superseded') {
    super(code);
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
