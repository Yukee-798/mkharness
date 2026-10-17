import { abortAllDurableObjects } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import {
  AgentDoc,
  defineTask,
  LiveDoc,
  type Harness,
  type ConversationId,
} from '@earendil-works/pi-durable';
import { env, runInDurableObject } from './env';
import { BG } from '../../src/server/chat/context';
import {
  Admissions,
  ExecutionBinding,
  PendingAdmissions,
  admissionKey,
  bindingKey,
  type AdmissionReceipt,
} from '../../src/server/chat/documents';
import { bindExecutionTask } from '../../src/server/chat/policy';
import { canonicalJson } from '../../src/shared/json';
import { AppError } from '../../src/shared/contracts';
import type { CredentialAccess } from '../../src/server/models/execution';

type Stub = ReturnType<typeof env.CONVERSATIONS.getByName>;
const command = (text: string) => ({ runId: crypto.randomUUID(), text });
function gate() {
  let resolve!: () => void;
  let resolved = false;
  const promise = new Promise<void>((done) => {
    resolve = () => {
      resolved = true;
      done();
    };
  });
  return {
    promise,
    resolve,
    get resolved() {
      return resolved;
    },
  };
}
async function admission(stub: Stub, target: number, runId: string) {
  return runInDurableObject(stub, async (instance) =>
    (await instance.harness.pi()).snapshot(Admissions, admissionKey(target, runId), BG),
  );
}
async function native(stub: Stub, target: number, runId: string) {
  return runInDurableObject(stub, async (instance) =>
    (await instance.harness.pi()).commit(
      (tx) => tx.submissionByRequest(target as ConversationId, runId),
      BG,
    ),
  );
}
async function preparedGap(stub: Stub, runId: string) {
  let restore!: () => void;
  await runInDurableObject(stub, (instance) => {
    const probe = instance as any,
      place = probe.place.bind(instance);
    probe.place = async (pi: Harness, key: string, receipt: AdmissionReceipt) => {
      if (receipt.requestId === runId && receipt.state === 'prepared')
        throw new AppError(503, 'prepared_gap');
      return place(pi, key, receipt);
    };
    restore = () => {
      probe.place = place;
    };
  });
  return () =>
    runInDurableObject(stub, () => {
      restore();
    });
}
async function holdFirstCredential(stub: Stub, fail: boolean) {
  const entered = gate(),
    release = gate();
  await runInDurableObject(stub, (instance) => {
    const probe = instance as any,
      credentials = probe.credentials.bind(instance);
    let first = true;
    probe.credentials = async (): Promise<CredentialAccess> => {
      const access: CredentialAccess = await credentials();
      return {
        select: access.select.bind(access),
        resolve: async (...args) => {
          if (first) {
            first = false;
            entered.resolve();
            await release.promise;
            if (fail) throw new AppError(503, 'credential_unavailable');
          }
          return access.resolve(...args);
        },
      };
    };
  });
  return { entered: () => entered.resolved, release: release.resolve };
}

it.each([false, true])(
  'withdraws a prepared task-owned child on root Stop while an ownerless fork continues (cold=%s)',
  async (cold) => {
    let stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
    const initial = command('authorized root execution before creating child');
    await stub.submitRun(initial);
    await (await stub.observeRun(initial.runId)).text();
    const childInput = command('prepared owned child must remain stopped'),
      forkInput = command('independent fork continues');
    const scopes = await runInDurableObject(stub, async (instance) => {
      const pi = await instance.harness.pi(),
        root = await instance.root();
      const owner = defineTask({
        name: 'test.pending-owner',
        version: 1,
        initial: () => ({ phase: 'wait' as const }),
        phases: { wait: async () => {} },
        abort: async () => {},
      });
      const at = (await root.context(BG)).entries.at(-1)!.id;
      const child = await root.commit(async (tx) => {
        const taskId = await tx.createTask(owner, {}, { ownership: { kind: 'conversation' } });
        await bindExecutionTask(tx, taskId, root.id);
        return tx.createConversation({ ownership: { kind: 'task', taskId } });
      }, BG);
      const fork = await root.fork(at, { ownership: { kind: 'ownerless' } }, BG);
      const model = (await pi.snapshot(AgentDoc, root.id, BG))!.model!;
      const binding = (await pi.snapshot(
        ExecutionBinding,
        bindingKey(model.provider, model.modelId),
        BG,
      ))!;
      const probe = instance as any,
        reconcile = probe.reconcilePrepared.bind(instance),
        place = probe.place.bind(instance);
      probe.reconcilePrepared = async () => {};
      probe.place = async () => {
        throw new AppError(503, 'prepared_gap');
      };
      try {
        const actor = await instance.actor();
        expect(
          await instance.command(actor, {
            type: 'submit',
            target: Number(child.id),
            command: childInput,
          }),
        ).toMatchObject({ error: { status: 404, code: 'not_found' } });
        expect(
          await instance.read(actor, { type: 'snapshot', target: Number(child.id) }),
        ).toMatchObject({ error: { status: 404, code: 'not_found' } });
        const denied = await instance.observe(actor, {
          runId: childInput.runId,
          target: Number(child.id),
        });
        expect(denied.status).toBe(404);
        expect(await denied.json()).toMatchObject({ error: { code: 'not_found' } });
        expect(
          await pi.snapshot(Admissions, admissionKey(child.id, childInput.runId), BG),
        ).toBeUndefined();
        // Trusted task sources use the current prepared receipt format; an external command cannot create it.
        const hash = Array.from(
          new Uint8Array(
            await crypto.subtle.digest(
              'SHA-256',
              new TextEncoder().encode(canonicalJson(childInput)),
            ),
          ),
          (byte) => byte.toString(16).padStart(2, '0'),
        ).join('');
        await pi.commit(async (tx) => {
          const pending = await tx.doc(PendingAdmissions),
            key = admissionKey(child.id, childInput.runId);
          await tx.doc(Admissions, key, {
            hash,
            state: 'prepared',
            conversationId: Number(child.id),
            requestId: childInput.runId,
            antecedents: [],
            pendingInput: JSON.stringify({
              request: childInput,
              execution: JSON.parse(binding.execution),
            }),
          });
          pending.keys.push(key);
        }, BG);
        expect(
          await instance.command(actor, {
            type: 'submit',
            target: Number(fork.id),
            command: forkInput,
          }),
        ).toMatchObject({ error: { code: 'prepared_gap' } });
      } finally {
        probe.reconcilePrepared = reconcile;
        probe.place = place;
      }
      if (cold) probe.finishStop = async () => {};
      return { root: Number(root.id), child: Number(child.id), fork: Number(fork.id) };
    });
    expect(await admission(stub, scopes.child, childInput.runId)).toMatchObject({
      state: 'prepared',
    });
    expect(await stub.stopConversation()).toEqual({ stopping: true });
    if (cold) {
      await abortAllDurableObjects();
      stub = env.CONVERSATIONS.get(stub.id);
      await stub.snapshot();
    } else {
      await expect.poll(async () => JSON.parse(await stub.snapshot()).stopping).toBe(false);
      await runInDurableObject(stub, (instance) => instance.alarm());
    }
    await expect
      .poll(async () => (await native(stub, scopes.fork, forkInput.runId))?.status)
      .toBe('done');
    expect(await admission(stub, scopes.child, childInput.runId)).toMatchObject({
      state: 'withdrawn',
    });
    expect(await native(stub, scopes.child, childInput.runId)).toBeUndefined();
    expect(await admission(stub, scopes.fork, forkInput.runId)).toMatchObject({
      state: 'admitted',
    });
    const text = await runInDurableObject(stub, async (instance) => {
      const pi = await instance.harness.pi(),
        child = (await pi.conversation(scopes.child as ConversationId, BG))!,
        fork = (await pi.conversation(scopes.fork as ConversationId, BG))!;
      return {
        child: JSON.stringify((await child.context(BG)).messages),
        fork: JSON.stringify((await fork.context(BG)).messages),
      };
    });
    expect(text.child).not.toContain(childInput.text);
    expect(text.fork).toContain(forkInput.text);
  },
);

it.each([false, true])(
  'withdraws a prepared follower after its native predecessor fails (cold=%s)',
  async (cold) => {
    let stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
    const hold = await holdFirstCredential(stub, true),
      first = command('original run fails'),
      follower = command('prepared follower must never start');
    try {
      await stub.submitRun(first);
      await expect.poll(hold.entered).toBe(true);
      const target = await runInDurableObject(stub, async (instance) =>
        Number((await instance.root()).id),
      );
      const restore = await preparedGap(stub, follower.runId);
      expect(await stub.submitRun(follower)).toMatchObject({ error: { code: 'prepared_gap' } });
      const original = (await native(stub, target, first.runId))!;
      expect(await admission(stub, target, follower.runId)).toMatchObject({
        state: 'prepared',
        antecedents: [Number(original.id)],
      });
      hold.release();
      await expect
        .poll(async () => (await stub.submission(first.runId))?.status)
        .toBe('unanswered');
      if (cold) {
        await abortAllDurableObjects();
        stub = env.CONVERSATIONS.get(stub.id);
        await stub.snapshot();
      } else {
        await restore();
        await runInDurableObject(stub, (instance) => instance.alarm());
      }
      expect(await admission(stub, target, follower.runId)).toMatchObject({ state: 'withdrawn' });
      expect(await native(stub, target, follower.runId)).toBeUndefined();
      expect(JSON.stringify(JSON.parse(await stub.snapshot()).entries)).not.toContain(
        follower.text,
      );
      const next = command('intentional new operation after failure');
      expect(await stub.submitRun(next)).toMatchObject({ accepted: true });
      await expect.poll(async () => (await stub.submission(next.runId))?.status).toBe('done');
    } finally {
      hold.release();
    }
  },
);

it.each([false, true])(
  'removing an unplaced predecessor does not withdraw a later prepared input (cold=%s)',
  async (cold) => {
    let stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
    const hold = await holdFirstCredential(stub, false),
      first = command('running predecessor'),
      removed = command('remove only this predecessor'),
      follower = command('prepared input survives one queue removal');
    try {
      await stub.submitRun(first);
      await expect.poll(hold.entered).toBe(true);
      await stub.submitRun(removed);
      const target = await runInDurableObject(stub, async (instance) =>
        Number((await instance.root()).id),
      );
      const restore = await preparedGap(stub, follower.runId);
      expect(await stub.submitRun(follower)).toMatchObject({ error: { code: 'prepared_gap' } });
      const before = await admission(stub, target, follower.runId);
      expect(before?.antecedents).toHaveLength(2);
      await stub.actOnQueuedInput(removed.runId, 'remove');
      const withdrawn = await native(stub, target, removed.runId);
      expect(withdrawn).toMatchObject({ status: 'unanswered', reason: 'aborted' });
      expect(withdrawn?.entry).toBeUndefined();
      hold.release();
      await expect.poll(async () => (await stub.submission(first.runId))?.status).toBe('done');
      if (cold) {
        await abortAllDurableObjects();
        stub = env.CONVERSATIONS.get(stub.id);
        await stub.snapshot();
      } else {
        await restore();
        await runInDurableObject(stub, (instance) => instance.alarm());
      }
      await expect.poll(async () => (await stub.submission(follower.runId))?.status).toBe('done');
      expect(await admission(stub, target, follower.runId)).toMatchObject({ state: 'admitted' });
      expect(JSON.stringify(JSON.parse(await stub.snapshot()).entries)).not.toContain(removed.text);
    } finally {
      hold.release();
    }
  },
);

it('serializes stale idle alarm cleanup and retains a wake while admission has not reached its native commit', async () => {
  let stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  await stub.snapshot();
  const deleting = gate(),
    releaseDelete = gate(),
    armed = gate(),
    releaseAdmission = gate();
  let cleanupFinished = false,
    restore!: () => void;
  const input = command('recover after the durable alarm gap'),
    target = await runInDurableObject(stub, async (instance, state) => {
      const probe = instance as any,
        pi = await instance.harness.pi();
      await probe.rearm(pi);
      expect(await state.storage.getAlarm()).toBeNull();
      const deleteAlarm = state.storage.deleteAlarm.bind(state.storage),
        arm = probe.arm.bind(instance),
        place = probe.place.bind(instance);
      let once = true;
      const spy = vi.spyOn(state.storage, 'deleteAlarm').mockImplementation(async () => {
        if (once) {
          once = false;
          deleting.resolve();
          await releaseDelete.promise;
        }
        await deleteAlarm();
      });
      probe.arm = async () => {
        await arm();
        armed.resolve();
        await releaseAdmission.promise;
      };
      probe.place = async () => {
        throw new AppError(503, 'prepared_gap');
      };
      restore = () => {
        spy.mockRestore();
        probe.arm = arm;
        probe.place = place;
      };
      const cleanup: Promise<void> = probe.rearm(pi);
      state.waitUntil(
        cleanup.then(() => {
          cleanupFinished = true;
        }),
      );
      return Number((await instance.root()).id);
    });
  try {
    await expect.poll(() => deleting.resolved).toBe(true);
    const submitted = stub.submitRun(input);
    await expect
      .poll(() => runInDurableObject(stub, (instance) => (instance as any).activeCommands))
      .toBe(1);
    expect(await admission(stub, target, input.runId)).toBeUndefined();
    releaseDelete.resolve();
    await expect.poll(() => cleanupFinished && armed.resolved).toBe(true);
    await runInDurableObject(stub, async (instance, state) => {
      const probe = instance as any;
      await probe.rearm(await instance.harness.pi());
      expect(probe.activeCommands).toBe(1);
      expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
      expect(
        await (await instance.harness.pi()).snapshot(LiveDoc, target as ConversationId, BG),
      ).not.toHaveProperty('run');
    });
    releaseAdmission.resolve();
    expect(await submitted).toMatchObject({ error: { code: 'prepared_gap' } });
    expect(await admission(stub, target, input.runId)).toMatchObject({ state: 'prepared' });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
      restore();
    });
    await abortAllDurableObjects();
    stub = env.CONVERSATIONS.get(stub.id);
    await stub.snapshot();
    await expect.poll(async () => (await stub.submission(input.runId))?.status).toBe('done');
    expect(await admission(stub, target, input.runId)).toMatchObject({ state: 'admitted' });
  } finally {
    releaseDelete.resolve();
    releaseAdmission.resolve();
  }
});
