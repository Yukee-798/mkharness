import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { registerStorageConformance } from '@earendil-works/pi-durable/testing';
import { createSession, UserEntry } from '@earendil-works/pi-durable';
import { openDurableObjectSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/cloudflare';
import { openChatStorage } from '../../src/server/chat/storage';
import type { StorageProbe } from './entry';
const probes = (env as unknown as { STORAGE_PROBES: DurableObjectNamespace<StorageProbe> })
  .STORAGE_PROBES;
import { BG as context } from '../../src/server/chat/context';
for (const indexed of [false, true])
  registerStorageConformance(
    { describe, expect, it },
    indexed ? 'chat atomic locators' : 'official Cloudflare SQLite',
    async (use) => {
      await runInDurableObject(probes.get(probes.newUniqueId()), async (_instance, state) => {
        const storage = indexed
          ? (await openChatStorage(state.storage)).storage
          : await openDurableObjectSqliteStorage(state.storage, { prefix: 'pi_' });
        await use(storage);
      });
    },
  );
it('rolls native writes back if a locator transaction fails', async () => {
  await runInDurableObject(probes.get(probes.newUniqueId()), async (_instance, state) => {
    const { storage, database, index } = await openChatStorage(state.storage);
    const session = createSession(storage);
    const conversation = await session.commit(
      (tx) => tx.createConversation({ ownership: { kind: 'ownerless' } }),
      context,
    );
    const before = await index.revision();
    await database.exec(
      "CREATE TRIGGER locator_failure BEFORE UPDATE ON app_read_meta BEGIN SELECT RAISE(ABORT,'locator_failed'); END;",
    );
    await expect(
      session.commit(
        (tx) =>
          tx.appendEntry(UserEntry, conversation.id, {
            model: [{ role: 'user', content: 'rolled back', timestamp: 1 }],
          }),
        context,
      ),
    ).rejects.toThrow('locator_failed');
    await session.closed;
    const recovered = await openChatStorage(state.storage);
    expect(
      await recovered.storage.scanEntries(
        { conversationId: conversation.id },
        10,
        undefined,
        context,
      ),
    ).toMatchObject({ items: [] });
    expect(await recovered.index.revision()).toBe(before);
    await recovered.storage.close(context);
  });
});
