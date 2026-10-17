import { abortAllDurableObjects } from 'cloudflare:test';
import { env, runInDurableObject } from './env';
import { expect, it } from 'vitest';
import { AgentDoc } from '@earendil-works/pi-durable';
import { BG } from '../../src/server/chat/context';
import {
  Admissions,
  PendingAdmissions,
  ExecutionBinding,
  admissionKey,
  bindingKey,
} from '../../src/server/chat/documents';

it('atomically freezes configuration with prepared admission, then shrinks the receipt after cold recovery', async () => {
  let stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const command = { runId: crypto.randomUUID(), text: 'frozen across acceptance gap' };
  let key = '';
  await runInDurableObject(stub, async (instance) => {
    const root = await instance.root(),
      probe = instance as any;
    key = admissionKey(root.id, command.runId);
    probe.place = async () => {
      throw new Error('test acceptance gap');
    };
  });
  expect(await stub.submitRun(command)).toMatchObject({ error: { status: 503 } });
  await runInDurableObject(stub, async (instance, state) => {
    const pi = await instance.harness.pi(),
      receipt = await pi.snapshot(Admissions, key, BG);
    expect(receipt).toMatchObject({ state: 'prepared', requestId: command.runId });
    expect((await pi.snapshot(PendingAdmissions, BG))?.keys).toEqual([key]);
    const model = (await pi.snapshot(AgentDoc, (await instance.root()).id, BG))!.model!;
    const binding = await pi.snapshot(
      ExecutionBinding,
      bindingKey(model.provider, model.modelId),
      BG,
    );
    expect(JSON.parse(binding!.execution)).toEqual(JSON.parse(receipt!.pendingInput!).execution);
    expect((await pi.inspect(BG)).submissions).toEqual([]);
    expect(
      state.storage.sql
        .exec(
          "SELECT name FROM sqlite_master WHERE name IN ('app_requests','app_request_execution','app_meta')",
        )
        .toArray(),
    ).toEqual([]);
  });
  await abortAllDurableObjects();
  stub = env.CONVERSATIONS.get(stub.id);
  await stub.snapshot();
  await expect.poll(async () => (await stub.submission(command.runId))?.status).toBe('done');
  await runInDurableObject(stub, async (instance) => {
    const pi = await instance.harness.pi(),
      receipt = await pi.snapshot(Admissions, key, BG);
    expect((await pi.snapshot(PendingAdmissions, BG))?.keys).toEqual([]);
    const before = (await instance.root()).id;
    const a = await instance.submission(command.runId);
    expect(receipt).toEqual({
      hash: expect.any(String),
      state: 'admitted',
      conversationId: Number(before),
      requestId: command.runId,
      submissionId: Number(a!.id),
    });
    await instance.submitRun(command);
    expect((await instance.submission(command.runId))?.id).toBe(a?.id);
    expect((await instance.root()).id).toBe(before);
  });
});
