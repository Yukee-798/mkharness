import { env, runInDurableObject } from 'cloudflare:test';
import {
  createSession,
  defineDoc,
  LiveDoc,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable';
import { openPiSessionStore } from 'agents/harness/pi';
import { expect, it } from 'vitest';
import { BG } from '../../src/server/conversation';
import { claimPiStorage, validatePiStorage } from '../../src/server/pi-storage';

const Probe = defineDoc({
  kind: 'test.writer-probe',
  version: 1,
  scope: 'session',
  initial: () => ({ generation: { message: { content: [{ text: 'first' }] } } }),
});

it('fences a replaced writer before it persists a stale cached delta, preserving replay', async () => {
  const target = env.CONVERSATIONS.getByName(crypto.randomUUID());
  await runInDurableObject(target, async (instance, state) => {
    await instance.harness.dispose();
    const a = createSession(claimPiStorage(await openPiSessionStore(state.storage), state.storage));
    await a.commit(async (tx) => {
      await tx.doc(Probe);
    }, BG);
    const b = createSession(claimPiStorage(await openPiSessionStore(state.storage), state.storage));
    await b.snapshot(Probe, BG);
    await b.commit(async (tx) => {
      (await tx.doc(Probe)).generation.message.content = [];
    }, BG);
    await expect(
      a.commit(async (tx) => {
        (await tx.doc(Probe)).generation.message.content[0]!.text += ' stale';
      }, BG),
    ).rejects.toMatchObject({ code: 'runtime_superseded' });
    const reader = createSession(await openPiSessionStore(state.storage));
    expect(await reader.snapshot(Probe, BG)).toEqual({ generation: { message: { content: [] } } });
    await Promise.all([a.close(BG), b.close(BG), reader.close(BG)]);
  });
});

it('rejects a malformed live document before scheduling, without altering committed history', async () => {
  const target = env.CONVERSATIONS.getByName(crypto.randomUUID());
  await runInDurableObject(target, async (instance, state) => {
    await instance.root();
    await instance.harness.dispose();
    const storage = await openPiSessionStore(state.storage);
    const record = await storage.findDocument(
      {
        kind: LiveDoc.definition.kind,
        scope: { kind: 'conversation', conversationId: ROOT_CONVERSATION_ID },
      },
      'current',
      BG,
    );
    const before = state.storage.sql.exec('SELECT count(*) AS n FROM pi_entries').one().n;
    await storage.commit(
      [
        {
          type: 'document.change',
          id: record!.id,
          content: {
            kind: 'delta',
            version: 1,
            ops: [['a', ['generation', 'message', 'content', 0, 'text'], 'stale']],
          },
        },
      ],
      BG,
    );
    await expect(validatePiStorage(storage)).rejects.toMatchObject({
      code: 'runtime_storage_invalid',
    });
    expect(state.storage.sql.exec('SELECT count(*) AS n FROM pi_entries').one().n).toBe(before);
    await storage.close(BG);
  });
});
