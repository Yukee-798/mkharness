import { abortAllDurableObjects, runDurableObjectAlarm } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { env, runInDurableObject } from './env';
import { BG } from '../../src/server/chat/context';
import {
  Admissions,
  QueueEdits,
  UnclaimedQueueEdits,
  admissionKey,
} from '../../src/server/chat/documents';
import { AppError } from '../../src/shared/contracts';
import type { RunCommand } from '../../src/shared/contracts';
import type { ConversationSnapshot } from '../../src/shared/conversation';

const command = (text: string): RunCommand => ({ runId: crypto.randomUUID(), text });
type Stub = ReturnType<typeof env.CONVERSATIONS.getByName>;
const edit = async (stub: Stub, runId: string) =>
  stub.command(await stub.actor(), { type: 'queue', runId, action: 'edit' });
const acknowledge = async (stub: Stub, runId: string) =>
  stub.command(await stub.actor(), { type: 'acknowledge_queue_edit', runId });
async function inspect(stub: Stub, runId: string) {
  return runInDurableObject(stub, async (instance) => {
    const pi = await instance.harness.pi(),
      root = await instance.root();
    const key = admissionKey(root.id, runId);
    return {
      receipt: await pi.snapshot(QueueEdits, key, BG),
      admission: await pi.snapshot(Admissions, key, BG),
      unclaimed: await pi.snapshot(UnclaimedQueueEdits, BG),
      submission: await root.commit((tx) => tx.submissionByRequest(root.id, runId), BG),
    };
  });
}

it('replays a lost full Edit draft after eviction, then acknowledges and removes its private payload', async () => {
  let stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const original = command('reply source');
  await stub.submitRun(original);
  await (await stub.observeRun(original.runId)).text();
  const snapshot = (await stub.read(await stub.actor(), {
    type: 'snapshot',
  })) as ConversationSnapshot;
  const answer = snapshot.entries.find((entry) => entry.kind === 'pi.assistant')!;
  await stub.submitRun(command('slow first'));
  const queued: RunCommand = {
    ...command('repeat the source'),
    images: [
      {
        name: 'queued.png',
        mimeType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jlp0AAAAASUVORK5CYII=',
      },
    ],
    config: { provider: 'fixture', modelId: 'fixture-pro', thinkingLevel: 'high' },
    source: {
      action: 'extension_action',
      extensionId: 'reply',
      name: 'regenerate',
      payload: { entryId: String(answer.id) },
    },
  };
  expect(await stub.submitRun(queued)).toMatchObject({ accepted: true });
  const { runId: _id, ...draft } = queued;
  // Discard the first successful response, as a browser transport failure would.
  expect(await edit(stub, queued.runId)).toMatchObject({ draft });
  await abortAllDurableObjects();
  stub = env.CONVERSATIONS.get(stub.id);
  expect(await stub.read(await stub.actor(), { type: 'snapshot' })).toMatchObject({
    queueEdits: [{ runId: queued.runId, expiresAt: expect.any(Number) }],
  });
  expect(await edit(stub, queued.runId)).toMatchObject({ draft });
  const state = await inspect(stub, queued.runId);
  expect(state.admission).toMatchObject({ state: 'withdrawn' });
  expect(state.admission).not.toHaveProperty('pendingInput');
  expect(state.submission).toMatchObject({ status: 'unanswered', reason: 'aborted' });
  expect(state.submission).not.toHaveProperty('entry');
  expect(JSON.stringify(await edit(stub, queued.runId))).not.toMatch(
    /credentialRef|apiKey|fingerprint/,
  );
  expect(await acknowledge(stub, queued.runId)).toEqual({ acknowledged: true });
  expect(await acknowledge(stub, queued.runId)).toEqual({ acknowledged: true });
  expect((await inspect(stub, queued.runId)).receipt).not.toHaveProperty('draft');
  expect((await inspect(stub, queued.runId)).unclaimed?.keys).toEqual([]);
  expect(await stub.read(await stub.actor(), { type: 'snapshot' })).toMatchObject({
    queueEdits: [],
  });
  expect(await edit(stub, queued.runId)).not.toHaveProperty('draft');
  expect(await stub.submitRun(queued)).toMatchObject({ error: { code: 'request_withdrawn' } });
  await stub.stopConversation();
});

it.each(['before-abort', 'after-abort', 'after-withdraw'] as const)(
  'finishes the same prepared transfer after a cold %s interruption without executing its input',
  async (gap) => {
    let stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
    await stub.submitRun(command('slow first'));
    const queued = command('must only be returned to the composer');
    await stub.submitRun(queued);
    await runInDurableObject(stub, async (instance) => {
      const pi = await instance.harness.pi();
      const abort = pi.abortSubmission.bind(pi);
      const host = instance as any,
        withdraw = host.withdraw.bind(instance);
      if (gap === 'after-withdraw')
        host.withdraw = async (...args: unknown[]) => {
          await withdraw(...args);
          throw new AppError(503, 'edit_receipt_gap');
        };
      else
        pi.abortSubmission = async (...args) => {
          if (gap === 'after-abort') await abort(...args);
          throw new AppError(503, 'edit_receipt_gap');
        };
      expect(
        await instance.command(await instance.actor(), {
          type: 'queue',
          runId: queued.runId,
          action: 'edit',
        }),
      ).toMatchObject({ error: { code: 'edit_receipt_gap' } });
      pi.abortSubmission = abort;
      host.withdraw = withdraw;
    });
    expect((await inspect(stub, queued.runId)).receipt?.state).toBe('prepared');
    await abortAllDurableObjects();
    stub = env.CONVERSATIONS.get(stub.id);
    expect(await edit(stub, queued.runId)).toMatchObject({ draft: { text: queued.text } });
    expect((await inspect(stub, queued.runId)).submission).toMatchObject({
      status: 'unanswered',
      reason: 'aborted',
    });
    expect(
      JSON.stringify(
        ((await stub.read(await stub.actor(), { type: 'snapshot' })) as ConversationSnapshot)
          .entries,
      ),
    ).not.toContain(queued.text);
    await acknowledge(stub, queued.runId);
    await stub.stopConversation();
  },
);

it('expires an unclaimed transfer on a cold alarm and rejects replay without keeping its draft', async () => {
  let stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  await stub.submitRun(command('slow first'));
  const queued = command('bounded private draft');
  await stub.submitRun(queued);
  expect(await edit(stub, queued.runId)).toMatchObject({ draft: { text: queued.text } });
  await runInDurableObject(stub, async (instance) => {
    const pi = await instance.harness.pi(),
      root = await instance.root();
    await pi.commit(async (tx) => {
      (await tx.doc(QueueEdits, admissionKey(root.id, queued.runId), null)).expiresAt =
        Date.now() - 1;
    }, BG);
  });
  await abortAllDurableObjects();
  stub = env.CONVERSATIONS.get(stub.id);
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  const state = await inspect(stub, queued.runId);
  expect(state.receipt).toMatchObject({ state: 'expired' });
  expect(state.receipt).not.toHaveProperty('draft');
  expect(state.unclaimed?.keys).toEqual([]);
  expect(await stub.read(await stub.actor(), { type: 'snapshot' })).toMatchObject({
    queueEdits: [],
  });
  expect(await edit(stub, queued.runId)).toMatchObject({ error: { code: 'queue_edit_expired' } });
  expect(await acknowledge(stub, queued.runId)).toEqual({ acknowledged: true });
  await stub.stopConversation();
});

it('does not capture or restore an input that has already been placed', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const started = command('already placed');
  await stub.submitRun(started);
  await (await stub.observeRun(started.runId)).text();
  expect(await edit(stub, started.runId)).toMatchObject({ error: { code: 'queue_item_started' } });
  expect((await inspect(stub, started.runId)).receipt).toBeUndefined();
  expect(await acknowledge(stub, started.runId)).toMatchObject({
    error: { code: 'queue_edit_not_found' },
  });
});

it('discards a prepared draft when the native scheduler wins the placement race', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  await stub.submitRun(command('slow first'));
  const queued = command('native placement wins');
  await stub.submitRun(queued);
  await runInDurableObject(stub, async (instance) => {
    const pi = await instance.harness.pi(),
      root = await instance.root();
    const abort = pi.abortSubmission.bind(pi);
    pi.abortSubmission = async (...args) => {
      const record = await root.commit((tx) => tx.submissionByRequest(root.id, queued.runId), BG);
      await (await pi.submission(record!.id, BG))!.wait(BG);
      return abort(...args);
    };
    try {
      expect(
        await instance.command(await instance.actor(), {
          type: 'queue',
          runId: queued.runId,
          action: 'edit',
        }),
      ).toMatchObject({ error: { code: 'queue_item_started' } });
    } finally {
      pi.abortSubmission = abort;
    }
  });
  const state = await inspect(stub, queued.runId);
  expect(state.receipt).toMatchObject({ state: 'started' });
  expect(state.receipt).not.toHaveProperty('draft');
  expect(state.unclaimed?.keys).toEqual([]);
  expect(state.submission).toMatchObject({ status: 'done' });
  expect(await edit(stub, queued.runId)).toMatchObject({ error: { code: 'queue_item_started' } });
});

it('keeps recovered Edit drafts private to their authenticated chat owner', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  await stub.submitRun(command('slow first'));
  const queued = command('owner-only edit draft');
  await stub.submitRun(queued);
  await edit(stub, queued.runId);
  const actor = await stub.actor();
  for (const request of [
    { type: 'queue' as const, runId: queued.runId, action: 'edit' as const },
    { type: 'acknowledge_queue_edit' as const, runId: queued.runId },
  ])
    expect(await stub.command({ ...actor, ownerId: 'foreign-owner' }, request)).toMatchObject({
      error: { status: 404 },
    });
  expect((await inspect(stub, queued.runId)).receipt).toMatchObject({ state: 'edited' });
  expect(await edit(stub, queued.runId)).toMatchObject({ draft: { text: queued.text } });
  await acknowledge(stub, queued.runId);
  await stub.stopConversation();
});

it('cannot retrieve or acknowledge a parent transfer through a different native fork target', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  await stub.submitRun(command('slow first'));
  const queued = command('parent-only draft');
  await stub.submitRun(queued);
  await edit(stub, queued.runId);
  const forkId = await runInDurableObject(stub, async (instance) => {
    const root = await instance.root();
    const page = await root.entries({ order: 'ascending' }, 1, undefined, BG);
    return Number((await root.fork(page.items[0].id, { ownership: { kind: 'ownerless' } }, BG)).id);
  });
  const actor = await stub.actor();
  expect(await stub.read(actor, { type: 'snapshot', target: forkId })).toMatchObject({
    queueEdits: [],
  });
  expect(
    await stub.command(actor, {
      type: 'queue',
      target: forkId,
      runId: queued.runId,
      action: 'edit',
    }),
  ).toMatchObject({ error: { code: 'run_not_found' } });
  expect(
    await stub.command(actor, {
      type: 'acknowledge_queue_edit',
      target: forkId,
      runId: queued.runId,
    }),
  ).toMatchObject({ error: { code: 'queue_edit_not_found' } });
  expect(await edit(stub, queued.runId)).toMatchObject({ draft: { text: queued.text } });
  await acknowledge(stub, queued.runId);
  await stub.stopConversation();
});
