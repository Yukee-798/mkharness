import { abortAllDurableObjects } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { UserEntry } from '@earendil-works/pi-durable';
import { env, runInDurableObject } from './env';
import { BG } from '../../src/server/chat/context';
import type { ConversationSnapshot, HistoryPage } from '../../src/shared/conversation';
import type { TimingState } from '../../src/extensions/timing/contracts';

it('restores the exact parent reply duration in fork snapshots and older pages after reconstruction', async () => {
  let stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const runId = crypto.randomUUID();
  await stub.submitRun({ runId, text: 'a normal inherited answer' });
  await (await stub.observeRun(runId)).text();
  const source = await runInDurableObject(stub, async (instance) => {
    const actor = await instance.actor();
    const root = await instance.root();
    const receipt = await root.commit((tx) => tx.submissionByRequest(root.id, runId), BG);
    if (receipt?.type !== 'input' || receipt.status !== 'done') throw new Error('answer missing');
    const parent = (await instance.read(actor, { type: 'snapshot' })) as ConversationSnapshot;
    const annotation = parent.history.annotations[String(receipt.answer)];
    expect((annotation?.timing as TimingState).replies[String(receipt.answer)]).toMatchObject({
      runId,
      startedAt: expect.any(Number),
      endedAt: expect.any(Number),
    });
    const fork = await root.fork(receipt.answer, { ownership: { kind: 'ownerless' } }, BG);
    const snapshot = (await instance.read(actor, {
      type: 'snapshot',
      target: Number(fork.id),
    })) as ConversationSnapshot;
    expect(snapshot.history.annotations[String(receipt.answer)]).toEqual(annotation);
    await fork.commit(async (tx) => {
      for (let n = 0; n < 150; n++)
        await tx.appendEntry(UserEntry, fork.id, {
          model: [{ role: 'user', content: 'later fork history ' + n, timestamp: n }],
        });
    }, BG);
    return { fork: Number(fork.id), answer: Number(receipt.answer), annotation };
  });
  await abortAllDurableObjects();
  stub = env.CONVERSATIONS.get(stub.id);
  await runInDurableObject(stub, async (instance) => {
    const actor = await instance.actor();
    let page = (await instance.read(actor, {
      type: 'snapshot',
      target: source.fork,
    })) as HistoryPage;
    expect(page.history.annotations[String(source.answer)]).toBeUndefined();
    while (page.history.olderCursor)
      page = (await instance.read(actor, {
        type: 'history',
        target: source.fork,
        cursor: page.history.olderCursor,
      })) as HistoryPage;
    expect(page.history.annotations[String(source.answer)]).toEqual(source.annotation);
  });
});

it('does not borrow a later ancestor tool receipt when two assistant rounds reuse a call ID', async () => {
  let stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const runId = crypto.randomUUID();
  await stub.submitRun({ runId, text: 'progress seam' });
  let assistant = 0;
  let firstAssistant = 0;
  await expect
    .poll(async () => {
      const snapshot = JSON.parse(await stub.snapshot()) as ConversationSnapshot;
      const calls = snapshot.entries.filter((entry) =>
        entry.model?.some(
          (message) =>
            message.role === 'assistant' &&
            message.content.some(
              (part) => part.type === 'toolCall' && part.name === 'progress_probe',
            ),
        ),
      );
      if (calls.length < 2) return false;
      firstAssistant = Number(calls[0]!.id);
      assistant = Number(calls[1]!.id);
      return snapshot.toolProgress?.[`${assistant}.same-call`]?.status === 'running';
    })
    .toBe(true);
  const forkId = await runInDurableObject(stub, async (instance) => {
    const root = await instance.root();
    const at = (await root.context(BG)).entries.find((entry) => Number(entry.id) === assistant)!.id;
    return Number((await root.fork(at, { ownership: { kind: 'ownerless' } }, BG)).id);
  });
  await (await stub.observeRun(runId)).text();
  const parent = JSON.parse(await stub.snapshot()) as ConversationSnapshot;
  expect(
    (parent.history.annotations[String(assistant)]?.timing as TimingState).tools[
      `${assistant}.same-call`
    ]?.endedAt,
  ).toBeTypeOf('number');
  await abortAllDurableObjects();
  stub = env.CONVERSATIONS.get(stub.id);
  await runInDurableObject(stub, async (instance) => {
    const fork = (await instance.read(await instance.actor(), {
      type: 'snapshot',
      target: forkId,
    })) as ConversationSnapshot;
    expect(fork.toolProgress?.[`${assistant}.same-call`]?.status).toBe('pending');
    expect(
      (fork.history.annotations[String(assistant)]?.timing as TimingState | undefined)?.tools[
        `${assistant}.same-call`
      ]?.endedAt,
    ).toBeUndefined();
    expect(
      (fork.history.annotations[String(firstAssistant)]?.timing as TimingState).tools[
        `${firstAssistant}.same-call`
      ],
    ).toEqual(
      (parent.history.annotations[String(firstAssistant)]?.timing as TimingState).tools[
        `${firstAssistant}.same-call`
      ],
    );
  });
});

it('does not expose a completed reply duration beyond a fork cut inside its final tool round', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const runId = crypto.randomUUID();
  await stub.submitRun({ runId, text: 'panel' });
  await (await stub.observeRun(runId)).text();
  await runInDurableObject(stub, async (instance) => {
    const actor = await instance.actor();
    const root = await instance.root();
    const receipt = await root.commit((tx) => tx.submissionByRequest(root.id, runId), BG);
    if (receipt?.type !== 'input' || receipt.status !== 'done') throw new Error('answer missing');
    const parent = (await instance.read(actor, { type: 'snapshot' })) as ConversationSnapshot;
    expect(
      (parent.history.annotations[String(receipt.answer)]?.timing as TimingState).replies[
        String(receipt.answer)
      ]?.endedAt,
    ).toBeTypeOf('number');
    const toolRound = parent.entries.findLast((entry) =>
      entry.model?.some(
        (message) =>
          message.role === 'assistant' &&
          message.content.some(
            (block) => block.type === 'toolCall' && block.name === 'present_openui',
          ),
      ),
    )!;
    const fork = await root.fork(toolRound.id, { ownership: { kind: 'ownerless' } }, BG);
    const snapshot = (await instance.read(actor, {
      type: 'snapshot',
      target: Number(fork.id),
    })) as ConversationSnapshot;
    expect(snapshot.toolProgress?.[`${toolRound.id}.same-call`]?.status).toBe('pending');
    expect(
      (snapshot.history.annotations[String(receipt.answer)]?.timing as TimingState | undefined)
        ?.replies[String(receipt.answer)]?.endedAt,
    ).toBeUndefined();
    const completed = await root.fork(
      (await root.context(BG)).entries.at(-1)!.id,
      { ownership: { kind: 'ownerless' } },
      BG,
    );
    const completeSnapshot = (await instance.read(actor, {
      type: 'snapshot',
      target: Number(completed.id),
    })) as ConversationSnapshot;
    expect(completeSnapshot.history.annotations[String(receipt.answer)]?.timing).toEqual(
      parent.history.annotations[String(receipt.answer)]?.timing,
    );
  });
});
