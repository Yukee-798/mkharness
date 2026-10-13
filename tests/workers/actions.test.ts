import { env, runInDurableObject, abortAllDurableObjects } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { AppError, USER_ACTION_CONTEXT } from '../../src/shared/contracts';

it('preserves the original payload and a normalized null through an acceptance gap', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  await runInDurableObject(stub, async (instance, state) => {
    const target = instance as any;
    const base = await target.contributions();
    let normalized = 0;
    target.contributions = async () => [
      ...base,
      {
        id: 'null-probe',
        actions: {
          choose: {
            normalize: async (payload: any) => {
              normalized++;
              payload.selected = 'normalized';
              return null;
            },
          },
        },
      },
    ];
    const request = {
      runId: crypto.randomUUID(),
      text: 'null choice',
      source: {
        action: 'extension_action',
        extensionId: 'null-probe',
        name: 'choose',
        payload: { selected: 'A' },
      },
    } as const;
    const enqueue = target.enqueue.bind(instance);
    target.enqueue = async () => {
      throw new AppError(503, 'acceptance_gap');
    };
    expect(await instance.submitRun(structuredClone(request))).toMatchObject({
      error: { code: 'acceptance_gap' },
    });
    const stored = JSON.parse(
      String(
        state.storage.sql.exec('SELECT payload FROM app_requests WHERE id=?', request.runId).one()
          .payload,
      ),
    );
    expect(stored.request).toEqual(request);
    expect(stored.sourceContext).toBeNull();
    target.enqueue = enqueue;
    expect(await instance.submitRun(structuredClone(request))).toMatchObject({ accepted: true });
    expect(normalized).toBe(1);
  });
  const snapshot = JSON.parse(await stub.snapshot());
  const user = snapshot.entries
    .flatMap((entry: any) => entry.model ?? [])
    .find((message: any) => message.role === 'user');
  expect(user.content).toBe('null choice' + USER_ACTION_CONTEXT + '\nnull');
});

it('freezes normalized action context once across the save/accept gap and compares the original request', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  await runInDurableObject(stub, async (instance, state) => {
    const target = instance as any;
    const base = await target.contributions();
    let calls = 0,
      current = 'click-time';
    target.contributions = async () => [
      ...base,
      {
        id: 'probe',
        actions: {
          choose: {
            normalize: async () => {
              calls++;
              return { value: current };
            },
          },
        },
      },
    ];
    const command = {
      runId: crypto.randomUUID(),
      text: 'choice',
      source: {
        action: 'extension_action',
        extensionId: 'probe',
        name: 'choose',
        payload: { selected: 'A' },
      },
    } as any;
    expect(
      await instance.submitRun({ ...command, source: { ...command.source, name: 'missing' } }),
    ).toMatchObject({ error: { code: 'extension_action_unavailable' } });
    expect(calls).toBe(0);
    const enqueue = target.enqueue.bind(instance);
    target.enqueue = async () => {
      throw new AppError(503, 'acceptance_gap');
    };
    expect(await instance.submitRun(command)).toMatchObject({ error: { code: 'acceptance_gap' } });
    const stored = JSON.parse(
      String(
        state.storage.sql.exec('SELECT payload FROM app_requests WHERE id=?', command.runId).one()
          .payload,
      ),
    );
    expect(stored).toMatchObject({
      request: command,
      execution: { provider: 'fixture', modelId: 'fixture' },
      sourceContext: { value: 'click-time' },
    });
    current = 'changed-after-save';
    target.enqueue = enqueue;
    expect(
      await instance.submitRun({
        ...command,
        source: { ...command.source, payload: { selected: 'B' } },
      }),
    ).toMatchObject({ error: { code: 'request_conflict' } });
    expect(await instance.submitRun(command)).toMatchObject({ accepted: true });
    expect(await instance.submitRun(command)).toMatchObject({ accepted: true });
    expect(calls).toBe(1);
  });
  const snapshot = JSON.parse(await stub.snapshot());
  const user = snapshot.entries
    .flatMap((entry: any) => entry.model ?? [])
    .filter((message: any) => message.role === 'user');
  expect(user).toHaveLength(1);
  expect(JSON.stringify(user)).toContain('click-time');
  expect(JSON.stringify(user)).not.toContain('changed-after-save');
});
it.each([
  [false, { value: 'frozen-context' }],
  [true, { value: 'frozen-context' }],
  [false, null],
  [true, null],
] as const)(
  'rebuild reconciles the frozen envelope (Pi accepted=%s, context=%j)',
  async (accepted, sourceContext) => {
    let stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
    const request = {
      runId: crypto.randomUUID(),
      text: 'frozen',
      source: {
        action: 'extension_action',
        extensionId: 'removed-after-save',
        name: 'choose',
        payload: {},
      },
    };
    await runInDurableObject(stub, async (instance, state) => {
      await instance.root();
      state.storage.sql.exec(
        'INSERT INTO app_requests(id,payload,accepted)VALUES(?,?,0)',
        request.runId,
        JSON.stringify({
          request,
          execution: {
            provider: 'fixture',
            modelId: 'fixture',
            thinkingLevel: 'off',
            credentialRef: { source: 'server', fingerprint: 'fixture-only' },
          },
          sourceContext,
        }),
      );
      if (accepted)
        await instance.harness.submit(
          request.text + USER_ACTION_CONTEXT + '\n' + JSON.stringify(sourceContext),
          { session: '1', operationId: request.runId, whenBusy: 'followUp' },
        );
    });
    await abortAllDurableObjects();
    stub = env.CONVERSATIONS.get(stub.id);
    for (let i = 0; i < 200; i++) {
      const snapshot = JSON.parse(await stub.snapshot());
      if (
        !snapshot.pending.length &&
        !(await runInDurableObject(stub, (instance) => instance.needsRecovery()))
      ) {
        const user = snapshot.entries
          .flatMap((entry: any) => entry.model ?? [])
          .filter((message: any) => message.role === 'user');
        expect(user).toHaveLength(1);
        expect(user[0].content).toBe(
          request.text + USER_ACTION_CONTEXT + '\n' + JSON.stringify(sourceContext),
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Frozen request did not settle');
  },
);
