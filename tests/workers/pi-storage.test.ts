import { env, runInDurableObject } from 'cloudflare:test';
import {
  createSession,
  defineDoc,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  UserEntry,
} from '@earendil-works/pi-durable';
import { openPiSessionStore } from 'agents/harness/pi';
import { expect, it, vi } from 'vitest';
import { BG } from '../../src/server/conversations/context';
import { claimPiStorage } from '../../src/server/conversations/pi-storage';
import { ConversationFactsIndex } from '../../src/server/conversations/facts-index';

const Probe = defineDoc({
  kind: 'test.writer-probe',
  version: 1,
  scope: 'session',
  initial: () => ({ generation: { message: { content: [{ text: 'first' }] } } }),
});

it('rolls native writes and derived locators back together when indexing fails', async () => {
  const target = env.CONVERSATIONS.getByName(crypto.randomUUID());
  await runInDurableObject(target, async (instance, state) => {
    await instance.root();
    await instance.harness.dispose();
    const index = new ConversationFactsIndex(state.storage);
    const before = state.storage.sql.exec('SELECT count(*) AS n FROM pi_entries').one().n;
    const revision = index.revision;
    const storage = await openPiSessionStore(state.storage);
    const session = createSession(
      claimPiStorage(storage, state.storage, undefined, (writes, seq) => {
        index.committed(writes, seq);
        throw new Error('index write failed');
      }),
    );
    await expect(
      session.commit(
        (tx) =>
          tx.appendEntry(UserEntry, ROOT_CONVERSATION_ID, {
            model: [{ role: 'user', content: 'must roll back', timestamp: 1 }],
          }),
        BG,
      ),
    ).rejects.toThrow('index write failed');
    expect(state.storage.sql.exec('SELECT count(*) AS n FROM pi_entries').one().n).toBe(before);
    expect(index.revision).toBe(revision);
    await session.close(BG);
  });
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

it('native recovery fails once on malformed persistence without rereading or altering history', async () => {
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
    const closed = vi.fn();
    const read = vi.spyOn(storage, 'document');
    const session = createSession(storage);
    session.subscribeClose(closed);
    await expect(session.snapshot(LiveDoc, ROOT_CONVERSATION_ID, BG)).rejects.toThrow();
    expect(await session.closed).toMatchObject({ reason: 'failed' });
    const reads = read.mock.calls.length;
    await expect(session.snapshot(LiveDoc, ROOT_CONVERSATION_ID, BG)).rejects.toMatchObject({
      name: 'SessionFailed',
    });
    expect(read).toHaveBeenCalledTimes(reads);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(state.storage.sql.exec('SELECT count(*) AS n FROM pi_entries').one().n).toBe(before);
    await storage.close(BG);
  });
});
