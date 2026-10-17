import { abortAllDurableObjects } from 'cloudflare:test';
import { env, runInDurableObject } from './env';
import { expect, it } from 'vitest';
import { Admissions, admissionKey } from '../../src/server/chat/documents';
import { BG } from '../../src/server/chat/context';
import { AppError, USER_ACTION_CONTEXT } from '../../src/shared/contracts';

it('preserves the original payload and a normalized null through an acceptance gap', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  await runInDurableObject(stub, async (instance) => {
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
    const place = target.place.bind(instance);
    target.place = async () => {
      throw new AppError(503, 'acceptance_gap');
    };
    expect(await instance.submitRun(structuredClone(request))).toMatchObject({
      error: { code: 'acceptance_gap' },
    });
    const stored = await pendingInput(instance, request.runId);
    expect(stored.request).toEqual(request);
    expect(stored.sourceContext).toBeNull();
    target.place = place;
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
  await runInDurableObject(stub, async (instance) => {
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
    const place = target.place.bind(instance);
    target.place = async () => {
      throw new AppError(503, 'acceptance_gap');
    };
    expect(await instance.submitRun(command)).toMatchObject({ error: { code: 'acceptance_gap' } });
    const stored = await pendingInput(instance, command.runId);
    expect(stored).toMatchObject({
      request: command,
      execution: { provider: 'fixture', modelId: 'fixture' },
      sourceContext: { value: 'click-time' },
    });
    current = 'changed-after-save';
    target.place = place;
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
    await runInDurableObject(stub, async (instance) => {
      const probe = instance as any,
        base = await probe.contributions();
      probe.contributions = async () => [
        ...base,
        { id: 'removed-after-save', actions: { choose: { normalize: async () => sourceContext } } },
      ];
      await instance.root();
      if (accepted) {
        const pi = await instance.harness.pi(),
          original = pi.conversation.bind(pi);
        pi.conversation = async (...args) => {
          const conversation = await original(...args);
          if (!conversation) return;
          const submit = conversation.submit.bind(conversation);
          conversation.submit = async (...input: Parameters<typeof submit>) => {
            await submit(...input);
            throw new AppError(503, 'acceptance_gap');
          };
          return conversation;
        };
      } else
        probe.place = async () => {
          throw new AppError(503, 'acceptance_gap');
        };
      expect(await instance.submitRun(request as any)).toMatchObject({
        error: { code: 'acceptance_gap' },
      });
    });
    await abortAllDurableObjects();
    stub = env.CONVERSATIONS.get(stub.id);
    for (let i = 0; i < 200; i++) {
      const snapshot = JSON.parse(await stub.snapshot());
      if (!snapshot.pending.length) {
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

async function pendingInput(instance: import('./entry').ChatSession, runId: string) {
  const pi = await instance.harness.pi(),
    root = await instance.root();
  const receipt = await pi.snapshot(Admissions, admissionKey(root.id, runId), BG);
  return JSON.parse(receipt!.pendingInput!);
}
