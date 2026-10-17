import { abortAllDurableObjects } from 'cloudflare:test';
import { env, runInDurableObject } from './env';
import { expect, it } from 'vitest';
import { Admissions, admissionKey } from '../../src/server/chat/documents';
import { BG } from '../../src/server/chat/context';
import { AppError } from '../../src/shared/contracts';
import { DEFAULT_COMPACTION_POLICY, UserEntry } from '@earendil-works/pi-durable';
import type { ConversationSnapshot } from '../../src/shared/conversation';

it('regeneration freezes the accepted input, deduplicates receipts and survives DO reconstruction without nesting', async () => {
  let stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const original = { runId: crypto.randomUUID(), text: 'Original question' };
  await stub.submitRun(original);
  await (await stub.observeRun(original.runId)).text();
  const first = JSON.parse(await stub.snapshot());
  const assistant = first.entries.findLast((e: any) => e.kind === 'pi.assistant');
  const command = {
    runId: crypto.randomUUID(),
    text: 'Regenerate response',
    source: {
      action: 'extension_action',
      extensionId: 'reply',
      name: 'regenerate',
      payload: { entryId: String(assistant.id) },
    },
  } as const;
  await runInDurableObject(stub, async (instance) => {
    const target = instance as any;
    const place = target.place.bind(target);
    target.place = async () => {
      throw new AppError(503, 'receipt_gap');
    };
    expect(await instance.submitRun(command)).toMatchObject({ error: { code: 'receipt_gap' } });
    const pi = await instance.harness.pi(),
      root = await instance.root();
    const receipt = await pi.snapshot(Admissions, admissionKey(root.id, command.runId), BG);
    const stored = JSON.parse(receipt!.pendingInput!);
    expect(stored.sourceContext).toEqual({
      action: 'regenerate',
      originalRequest: { text: 'Original question' },
    });
    expect(stored.sourceContext).not.toHaveProperty('execution');
    target.place = place;
  });
  await abortAllDurableObjects();
  stub = env.CONVERSATIONS.get(stub.id);
  expect(await stub.submitRun(command)).toMatchObject({ accepted: true });
  expect(await stub.submitRun(command)).toMatchObject({ accepted: true });
  await (await stub.observeRun(command.runId)).text();
  const restored = JSON.parse(await stub.snapshot());
  expect(restored.entries.filter((e: any) => e.kind === 'app.input')).toHaveLength(2);
  expect(JSON.stringify(restored.entries)).toContain('Original question');
  const next = restored.entries.findLast((e: any) => e.kind === 'pi.assistant');
  const repeat = {
    ...command,
    runId: crypto.randomUUID(),
    source: { ...command.source, payload: { entryId: String(next.id) } },
  };
  expect(await stub.submitRun(repeat)).toMatchObject({ accepted: true });
  await (await stub.observeRun(repeat.runId)).text();
  await runInDurableObject(stub, async (instance) => {
    const entries = await instance.allEntries();
    const input = entries.findLast((e) => e.kind === 'app.input')!;
    expect((input.data as any).context).toEqual({
      action: 'regenerate',
      originalRequest: { text: 'Original question' },
    });
  });
  const other = env.CONVERSATIONS.getByName(crypto.randomUUID());
  expect(await other.submitRun({ ...command, runId: crypto.randomUUID() })).toMatchObject({
    error: { code: 'reply_not_found' },
  });
});

it('regenerates a compacted answer from an older history page after reconstruction', async () => {
  let stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const original = { runId: crypto.randomUUID(), text: 'Original question before compaction' };
  await stub.submitRun(original);
  await (await stub.observeRun(original.runId)).text();
  const receipt = await runInDurableObject(stub, async (instance) => {
    const root = await instance.root();
    const receipt = await root.commit((tx) => tx.submissionByRequest(root.id, original.runId), BG);
    if (receipt?.type !== 'input' || receipt.status !== 'done') throw new Error('answer missing');
    return { entry: Number(receipt.entry), answer: Number(receipt.answer) };
  });
  const later = { runId: crypto.randomUUID(), text: 'Later retained question' };
  await stub.submitRun(later);
  await (await stub.observeRun(later.runId)).text();
  const keepRecentTokens = DEFAULT_COMPACTION_POLICY.keepRecentTokens;
  DEFAULT_COMPACTION_POLICY.keepRecentTokens = 0;
  try {
    await runInDurableObject(stub, async (instance) => {
      const root = await instance.root();
      const pi = await instance.harness.pi();
      const compaction = await root.compact(undefined, BG);
      expect((await pi.waitForTask(compaction, BG)).state.outcome.status).toBe('completed');
      const active = (await root.context(BG)).entries;
      expect(
        active.some((entry) => entry.id === receipt.entry || entry.id === receipt.answer),
      ).toBe(false);
      await root.commit(async (tx) => {
        for (let n = 0; n < 250; n++)
          await tx.appendEntry(UserEntry, root.id, {
            model: [{ role: 'user', content: 'later history ' + n, timestamp: n }],
          });
      }, BG);
    });
  } finally {
    DEFAULT_COMPACTION_POLICY.keepRecentTokens = keepRecentTokens;
  }
  await abortAllDurableObjects();
  stub = env.CONVERSATIONS.get(stub.id);
  let page = JSON.parse(await stub.snapshot()) as ConversationSnapshot;
  expect(page.entries.some((entry) => entry.id === receipt.answer)).toBe(false);
  while (page.history.olderCursor)
    page = JSON.parse(await stub.readHistory(page.history.olderCursor));
  expect(page.entries.some((entry) => entry.id === receipt.answer)).toBe(true);
  const regenerate = {
    runId: crypto.randomUUID(),
    text: 'Regenerate response',
    source: {
      action: 'extension_action',
      extensionId: 'reply',
      name: 'regenerate',
      payload: { entryId: String(receipt.answer) },
    },
  } as const;
  expect(await stub.submitRun(regenerate)).toMatchObject({ accepted: true });
  await (await stub.observeRun(regenerate.runId)).text();
  await runInDurableObject(stub, async (instance) => {
    const entries = await instance.allEntries();
    const input = entries.findLast((entry) => entry.kind === 'app.input')!;
    expect((input.data as any).context).toEqual({
      action: 'regenerate',
      originalRequest: { text: original.text },
    });
  });
});

it('authorizes regeneration against fork-visible answers and the owning chat actor', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const original = { runId: crypto.randomUUID(), text: 'Inherited question' };
  await stub.submitRun(original);
  await (await stub.observeRun(original.runId)).text();
  await runInDurableObject(stub, async (instance) => {
    const actor = await instance.actor();
    const root = await instance.root();
    const receipt = await root.commit((tx) => tx.submissionByRequest(root.id, original.runId), BG);
    if (receipt?.type !== 'input' || receipt.status !== 'done') throw new Error('answer missing');
    const fork = await root.fork(receipt.answer, { ownership: { kind: 'ownerless' } }, BG);
    const sibling = await root.fork(receipt.entry, { ownership: { kind: 'ownerless' } }, BG);
    const command = {
      runId: crypto.randomUUID(),
      text: 'Regenerate response',
      source: {
        action: 'extension_action',
        extensionId: 'reply',
        name: 'regenerate',
        payload: { entryId: String(receipt.answer) },
      },
    } as const;
    expect(
      await instance.command(actor, { type: 'submit', target: Number(sibling.id), command }),
    ).toMatchObject({ error: { code: 'reply_not_found' } });
    expect(
      await instance.command(
        { ...actor, ownerId: 'another-owner' },
        { type: 'submit', target: Number(fork.id), command },
      ),
    ).toMatchObject({ error: { code: 'not_found' } });
    expect(
      await instance.command(actor, { type: 'submit', target: Number(fork.id), command }),
    ).toMatchObject({ accepted: true });
    await (await instance.observe(actor, { target: Number(fork.id), runId: command.runId })).text();
    const inputs = (await fork.context(BG)).entries.filter((entry) => entry.kind === 'app.input');
    expect((inputs.at(-1)!.data as any).context).toEqual({
      action: 'regenerate',
      originalRequest: { text: original.text },
    });
  });
});
