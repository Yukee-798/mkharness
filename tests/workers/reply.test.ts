import { env, runInDurableObject, abortAllDurableObjects } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { AppError } from '../../src/shared/contracts';

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
  await runInDurableObject(stub, async (instance, state) => {
    const target = instance as any;
    const enqueue = target.enqueue.bind(target);
    target.enqueue = async () => {
      throw new AppError(503, 'receipt_gap');
    };
    expect(await instance.submitRun(command)).toMatchObject({ error: { code: 'receipt_gap' } });
    const stored = JSON.parse(
      String(
        state.storage.sql.exec('SELECT payload FROM app_requests WHERE id=?', command.runId).one()
          .payload,
      ),
    );
    expect(stored.sourceContext).toEqual({
      action: 'regenerate',
      originalRequest: { text: 'Original question' },
    });
    expect(stored.sourceContext).not.toHaveProperty('execution');
    target.enqueue = enqueue;
  });
  await abortAllDurableObjects();
  stub = env.CONVERSATIONS.get(stub.id);
  expect(await stub.submitRun(command)).toMatchObject({ accepted: true });
  expect(await stub.submitRun(command)).toMatchObject({ accepted: true });
  await (await stub.observeRun(command.runId)).text();
  const restored = JSON.parse(await stub.snapshot());
  expect(restored.entries.filter((e: any) => e.kind === 'pi.user')).toHaveLength(2);
  expect(JSON.stringify(restored.entries)).toContain('Original question');
  const next = restored.entries.findLast((e: any) => e.kind === 'pi.assistant');
  const repeat = {
    ...command,
    runId: crypto.randomUUID(),
    source: { ...command.source, payload: { entryId: String(next.id) } },
  };
  expect(await stub.submitRun(repeat)).toMatchObject({ accepted: true });
  await (await stub.observeRun(repeat.runId)).text();
  await runInDurableObject(stub, (_instance, state) => {
    const stored = JSON.parse(
      String(
        state.storage.sql.exec('SELECT payload FROM app_requests WHERE id=?', repeat.runId).one()
          .payload,
      ),
    );
    expect(stored.sourceContext).toEqual({
      action: 'regenerate',
      originalRequest: { text: 'Original question' },
    });
  });
  const other = env.CONVERSATIONS.getByName(crypto.randomUUID());
  expect(await other.submitRun({ ...command, runId: crypto.randomUUID() })).toMatchObject({
    error: { code: 'reply_not_found' },
  });
});
