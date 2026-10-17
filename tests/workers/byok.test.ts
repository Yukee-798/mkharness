import { abortAllDurableObjects } from 'cloudflare:test';
import { env, runInDurableObject } from './env';
import { it, expect } from 'vitest';
import { ModelCredentials } from '../../src/server/models/credentials';
import { AppError } from '../../src/shared/contracts';
import type { CredentialAccess } from '../../src/server/models/execution';
import {
  Admissions,
  ExecutionBinding,
  admissionKey,
  bindingKey,
  type AdmissionReceipt,
} from '../../src/server/chat/documents';
import { BG } from '../../src/server/chat/context';
import { ConversationPolicy, ExecutionScope } from '../../src/server/chat/policy';
import {
  CompactionTask,
  LiveDoc,
  UserEntry,
  AssistantEntry,
  type Harness,
} from '@earendil-works/pi-durable';
import { usage, model } from '../fixture-model';
import { configuredExecution } from './chat-fixture';
async function fixture() {
  const owner = crypto.randomUUID(),
    chat = crypto.randomUUID(),
    now = Date.now();
  await env.DB.prepare(
    'INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt,isAnonymous) VALUES(?,?,?,0,?,?,1)',
  )
    .bind(owner, 'guest', owner + '@test.invalid', now, now)
    .run();
  await env.DB.prepare(
    'INSERT INTO conversations(id,owner,create_request_id,create_hash,instance_generation,title,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
  )
    .bind(chat, owner, crypto.randomUUID(), 'fixture', crypto.randomUUID(), 'binding', now, now)
    .run();
  const store = new ModelCredentials(env, owner);
  return { store, stub: env.BYOK_PROBES.getByName(chat) as any };
}
async function settle(stub: any) {
  for (let i = 0; i < 300; i++) {
    const s = JSON.parse(await stub.snapshot());
    if (!s.pending.length) return s;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error('queue timeout');
}
async function receipt(stub: ReturnType<typeof env.BYOK_PROBES.getByName>, runId: string) {
  return runInDurableObject(stub, async (instance) => {
    const probe = instance as unknown as import('./byok-entry').BYOKProbe;
    const root = await probe.root(),
      pi = await probe.harness.pi();
    return pi.snapshot(Admissions, admissionKey(root.id, runId), BG);
  });
}
async function currentExecution(stub: ReturnType<typeof env.BYOK_PROBES.getByName>) {
  return runInDurableObject(stub, async (instance) => {
    const probe = instance as unknown as import('./byok-entry').BYOKProbe;
    const root = await probe.root();
    return configuredExecution(await probe.harness.pi(), root.id);
  });
}
async function beforeNative(
  stub: ReturnType<typeof env.BYOK_PROBES.getByName>,
  code: string,
  once = false,
) {
  await runInDurableObject(stub, (instance) => {
    const probe = instance as any;
    const place = probe.place.bind(instance);
    let remaining = once ? 1 : Infinity;
    probe.place = async (pi: Harness, key: string, intent: AdmissionReceipt) => {
      if (intent.state === 'prepared' && remaining-- > 0) throw new AppError(503, code);
      return place(pi, key, intent);
    };
  });
}
async function lostNativeAcknowledgement(stub: ReturnType<typeof env.BYOK_PROBES.getByName>) {
  await runInDurableObject(stub, async (instance) => {
    const pi = await instance.harness.pi(),
      commit = pi.commit.bind(pi);
    let once = true;
    pi.commit = (async (change: any, context: any) =>
      commit(async (tx: import('@earendil-works/pi-durable').Tx) => {
        const doc = tx.doc.bind(tx),
          touched: any[] = [];
        tx.doc = (async (...args: any[]) => {
          const value = await (doc as any)(...args);
          if (args[0] === Admissions) touched.push(value);
          return value;
        }) as typeof tx.doc;
        let value;
        try {
          value = await change(tx);
        } finally {
          tx.doc = doc;
        }
        if (once && touched.some((intent) => intent.state === 'admitted')) {
          once = false;
          throw new AppError(503, 'fixture_lost_acceptance_ack');
        }
        return value;
      }, context)) as typeof pi.commit;
  });
}
it('reads completed history after its model is removed and accepts a remaining model', async () => {
  const { store, stub: original } = await fixture();
  await store.save('fixture', { apiKey: 'key-original', expectedCurrentId: null });
  const runId = crypto.randomUUID();
  await original.submitRun({
    runId,
    text: 'completed on removed model',
    config: {
      provider: 'fixture',
      modelId: 'fixture-pro',
      thinkingLevel: 'high',
    },
  });
  await settle(original);
  await runInDurableObject(original, (_instance, state) => {
    state.storage.sql.exec('CREATE TABLE test_removed_model(id TEXT)');
    state.storage.sql.exec('INSERT INTO test_removed_model VALUES(?)', 'fixture-pro');
  });
  await abortAllDurableObjects();
  const stub = (env.BYOK_PROBES as any).get(original.id);
  expect(JSON.stringify(await settle(stub))).toContain('completed on removed model');
  expect((await stub.submission(runId))!.status).toBe('done');
  const next = crypto.randomUUID();
  expect(await stub.submitRun({ runId: next, text: 'remaining model' })).toMatchObject({
    accepted: true,
  });
  await settle(stub);
  expect((await stub.submission(next))!.status).toBe('done');
});
it('settles a host acceptance gap with no_model after catalog removal while retaining history and Stop', async () => {
  const { store, stub: original } = await fixture();
  await store.save('fixture', { apiKey: 'key-original', expectedCurrentId: null });
  await beforeNative(original, 'fixture_before_native_acceptance');
  const runId = crypto.randomUUID();
  expect(
    await original.submitRun({
      runId,
      text: 'pending on removed model',
      config: { provider: 'fixture', modelId: 'fixture-pro', thinkingLevel: 'high' },
    }),
  ).toMatchObject({ error: { code: 'fixture_before_native_acceptance' } });
  await runInDurableObject(original, (_instance, state) => {
    state.storage.sql.exec('CREATE TABLE test_removed_model(id TEXT)');
    state.storage.sql.exec('INSERT INTO test_removed_model VALUES(?)', 'fixture-pro');
  });
  await abortAllDurableObjects();
  const stub = (env.BYOK_PROBES as any).get(original.id);
  await expect
    .poll(async () => (await stub.submission(runId))?.status, { timeout: 6000 })
    .toBe('unanswered');
  expect(await stub.submission(runId)).toMatchObject({ reason: 'no_model' });
  expect(JSON.stringify(await settle(stub))).toContain('pending on removed model');
  expect(await stub.stopConversation()).toMatchObject({ stopping: true });
  await expect.poll(async () => JSON.parse(await stub.snapshot()).stopping).toBe(false);
  const next = crypto.randomUUID();
  expect(await stub.submitRun({ runId: next, text: 'remaining model' })).toMatchObject({
    accepted: true,
  });
  await settle(stub);
  expect(await stub.submission(next)).toMatchObject({ status: 'done' });
  expect((await stub.calls()).every((call: any) => call.model !== 'fixture-pro')).toBe(true);
});
it('withdraws a native queued follower during Stop and restores history after its model disappears', async () => {
  const { store, stub: original } = await fixture();
  await store.save('fixture', { apiKey: 'key-original', expectedCurrentId: null });
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await runInDurableObject(original, (instance) => {
    const probe = instance as any,
      credentials = probe.credentials.bind(instance);
    let first = true;
    probe.credentials = async () => {
      const access = await credentials();
      return {
        select: access.select.bind(access),
        resolve: async (...args: Parameters<CredentialAccess['resolve']>) => {
          if (first) {
            first = false;
            entered = true;
            await gate;
          }
          return access.resolve(...args);
        },
      };
    };
  });
  const a = crypto.randomUUID(),
    b = crypto.randomUUID();
  try {
    await original.submitRun({ runId: a, text: 'stopped parent' });
    await expect.poll(() => entered).toBe(true);
    await original.submitRun({
      runId: b,
      text: 'unexecuted removed follower',
      config: { provider: 'fixture', modelId: 'fixture-pro', thinkingLevel: 'high' },
    });
    expect((await original.submission(b))!.status).toBe('queued');
    expect(await original.stopConversation()).toMatchObject({ stopping: true });
    release();
    await expect.poll(async () => JSON.parse(await original.snapshot()).stopping).toBe(false);
    await runInDurableObject(original, (_, state) => {
      state.storage.sql.exec('CREATE TABLE test_removed_model(id TEXT)');
      state.storage.sql.exec('INSERT INTO test_removed_model VALUES(?)', 'fixture-pro');
    });
    await abortAllDurableObjects();
    const stub = (env.BYOK_PROBES as any).get(original.id),
      snapshot = await settle(stub);
    expect(snapshot.pending).toEqual([]);
    expect(JSON.stringify(snapshot.entries)).not.toContain('unexecuted removed follower');
    expect(await stub.submission(b)).toMatchObject({ status: 'unanswered', reason: 'aborted' });
    const next = crypto.randomUUID();
    expect(await stub.submitRun({ runId: next, text: 'remaining model' })).toMatchObject({
      accepted: true,
    });
    await settle(stub);
    expect((await stub.submission(next))!.status).toBe('done');
  } finally {
    release();
  }
});
it('reconciles an already completed native receipt without its removed model or resubmission', async () => {
  const { store, stub: original } = await fixture();
  await store.save('fixture', { apiKey: 'key-original', expectedCurrentId: null });
  await lostNativeAcknowledgement(original);
  const request = {
    runId: crypto.randomUUID(),
    text: 'completed before host receipt',
    config: { provider: 'fixture', modelId: 'fixture-pro', thinkingLevel: 'high' as const },
  };
  expect(await original.submitRun(request)).toMatchObject({
    error: { code: 'fixture_lost_acceptance_ack' },
  });
  await expect.poll(async () => (await original.submission(request.runId))!.status).toBe('done');
  const calls = await original.calls();
  expect(await receipt(original, request.runId)).toMatchObject({ state: 'prepared' });
  await runInDurableObject(original, (_instance, state) => {
    state.storage.sql.exec('CREATE TABLE test_removed_model(id TEXT)');
    state.storage.sql.exec('INSERT INTO test_removed_model VALUES(?)', 'fixture-pro');
  });
  await abortAllDurableObjects();
  const stub = (env.BYOK_PROBES as any).get(original.id);
  const snapshot = await settle(stub);
  expect(JSON.stringify(snapshot.entries)).toContain('completed before host receipt');
  expect(await stub.submitRun(request)).toMatchObject({ accepted: true });
  expect(await receipt(stub, request.runId)).toMatchObject({ state: 'admitted' });
  expect(await stub.calls()).toEqual(calls);
  const after = await settle(stub);
  expect(after.entries).toEqual(snapshot.entries);
  expect((await stub.submission(request.runId))!.status).toBe('done');
});
it('restores prepared D1 credentials while queued messages use the latest accepted configuration', async () => {
  const { store, stub: original } = await fixture();
  let stub = original;
  const first = await store.save('fixture', {
    apiKey: 'key-first',
    baseUrl: 'https://first.example.com/v1',
    expectedCurrentId: null,
  });
  const a = {
    runId: crypto.randomUUID(),
    text: 'slow first',
    config: { provider: 'fixture', modelId: 'fixture', thinkingLevel: 'low' as const },
  };
  expect(await stub.submitRun(a)).toMatchObject({ accepted: true });
  await expect.poll(async () => (await stub.calls()).length).toBe(1);
  const bindings = [await currentExecution(stub)];
  const second = await store.save('fixture', {
    apiKey: 'key-second',
    baseUrl: 'https://second.example.com/v1',
    expectedCurrentId: first.currentId,
  });
  const b = {
    runId: crypto.randomUUID(),
    text: 'second',
    config: { provider: 'fixture', modelId: 'fixture-pro', thinkingLevel: 'high' as const },
  };
  expect(await stub.submitRun(b)).toMatchObject({ accepted: true });
  bindings.push(await currentExecution(stub));
  const third = await store.save('fixture', {
    apiKey: 'key-third',
    baseUrl: 'https://third.example.com/v1',
    expectedCurrentId: second.currentId,
  });
  const c = { runId: crypto.randomUUID(), text: 'third', config: b.config };
  expect(await stub.submitRun(c)).toMatchObject({ accepted: true });
  bindings.push(await currentExecution(stub));
  expect(await stub.submitRun(b)).toMatchObject({ accepted: true });
  await abortAllDurableObjects();
  stub = (env.BYOK_PROBES as any).get(stub.id);
  const snapshot = await settle(stub);
  const records = await runInDurableObject(stub, async (instance) => {
    const pi = await (instance as unknown as import('./byok-entry').BYOKProbe).harness.pi();
    return Promise.all(
      bindings.map(async ({ ref, execution }) => {
        const frozen = await pi.snapshot(
          ExecutionBinding,
          bindingKey(ref.provider, ref.modelId),
          BG,
        );
        expect(JSON.parse(frozen!.execution)).toEqual(execution);
        return execution;
      }),
    );
  });
  expect(records.map((execution) => execution.credentialRef)).toEqual([
    { source: 'user', id: first.currentId },
    { source: 'user', id: second.currentId },
    { source: 'user', id: third.currentId },
  ]);
  const calls = await stub.calls();
  expect(
    calls.every((c: any) =>
      c.model === 'fixture'
        ? c.version === 'first' && c.base_url === 'https://first.example.com/v1'
        : c.version === 'third' && c.base_url === 'https://third.example.com/v1',
    ),
  ).toBe(true);
  expect(calls.some((c: any) => c.model === 'fixture-pro' && c.version === 'third')).toBe(true);
  expect(JSON.stringify(snapshot)).not.toMatch(/key-first|key-second|key-third|mkharness-bound/);
  expect(JSON.stringify(records)).not.toMatch(/key-first|key-second|key-third/);
});
it('fails queued work after revocation without using a newer or deployment key', async () => {
  const { store, stub } = await fixture();
  const first = await store.save('fixture', { apiKey: 'key-first', expectedCurrentId: null });
  await stub.submitRun({ runId: crypto.randomUUID(), text: 'slow first' });
  await stub.submitRun({ runId: crypto.randomUUID(), text: 'second' });
  await store.remove('fixture', first.currentId);
  await store.save('fixture', { apiKey: 'key-third', expectedCurrentId: null });
  const snapshot = await settle(stub);
  expect(JSON.stringify(snapshot)).toContain('原请求的个人凭据已撤销或过期');
  expect(JSON.stringify(snapshot)).not.toContain('mkharness-bound-');
  expect((await stub.calls()).every((c: any) => c.version === 'first')).toBe(true);
});
it('rejects missing credentials and forged client credentials before saving a request', async () => {
  const { stub } = await fixture();
  expect(await stub.submitRun({ runId: crypto.randomUUID(), text: 'hello' })).toMatchObject({
    error: { code: 'credential_required' },
  });
  expect(
    await stub.submitRun({ runId: crypto.randomUUID(), text: 'hello', apiKey: 'forged' } as any),
  ).toMatchObject({ error: { code: 'invalid_request' } });
});
it('restores a real D1 credential pinned by native background compaction while a newer configuration runs', async () => {
  const { store, stub: original } = await fixture();
  const first = await store.save('fixture', {
    apiKey: 'key-first',
    baseUrl: 'https://first.example.com/v1',
    expectedCurrentId: null,
  });
  await original.submitRun({ runId: crypto.randomUUID(), text: 'initial history' });
  await settle(original);
  const firstScope = await runInDurableObject(original, async (instance) => {
    const probe = instance as unknown as import('./byok-entry').BYOKProbe;
    const root = await probe.root(),
      pi = await probe.harness.pi();
    return (await pi.snapshot(ConversationPolicy, String(root.id), BG))!.scope!;
  });
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await runInDurableObject(original, async (instance) => {
    const probe = instance as any,
      credentials = probe.credentials.bind(instance);
    let firstResolve = true;
    probe.credentials = async () => {
      const access = await credentials();
      return {
        select: access.select.bind(access),
        resolve: async (...args: Parameters<CredentialAccess['resolve']>) => {
          if (firstResolve) {
            firstResolve = false;
            entered = true;
            await gate;
          }
          return access.resolve(...args);
        },
      };
    };
    const root = await probe.root(),
      pi = await probe.harness.pi();
    await root.commit(async (tx: import('@earendil-works/pi-durable').Tx) => {
      await tx.appendEntry(UserEntry, root.id, {
        model: [{ role: 'user', content: 'history '.repeat(8_000), timestamp: 1 }],
      });
      await tx.appendEntry(AssistantEntry, root.id, {
        model: [
          {
            role: 'assistant',
            api: model.api,
            provider: model.provider,
            model: model.id,
            content: [{ type: 'text', text: 'response '.repeat(8_000) }],
            usage,
            stopReason: 'stop',
            timestamp: 2,
          },
        ],
      });
      await tx.appendEntry(UserEntry, root.id, {
        model: [{ role: 'user', content: 'recent history', timestamp: 3 }],
      });
      await tx.appendEntry(AssistantEntry, root.id, {
        model: [
          {
            role: 'assistant',
            api: model.api,
            provider: model.provider,
            model: model.id,
            content: [{ type: 'text', text: 'recent answer' }],
            usage,
            stopReason: 'stop',
            timestamp: 4,
          },
        ],
      });
      const taskId = await tx.createTask(
        CompactionTask,
        { reason: 'threshold' },
        { ownership: { kind: 'conversation' }, background: true },
      );
      // Match Pi's current native background-compaction creation transaction, including its live locator.
      (await tx.doc(LiveDoc, root.id)).compactions = [
        { taskId, reason: 'threshold', blocking: false, attempt: 1 },
      ];
    }, BG);
    pi.resume();
  });
  try {
    await expect.poll(() => entered).toBe(true);
    const pinned = await runInDurableObject(
      original,
      async (instance) =>
        (await (await (instance as any).harness.pi()).inspect(BG)).tasks.find(
          (task: import('@earendil-works/pi-durable').TaskInspection) =>
            task.record.kind === CompactionTask.definition.name,
        )?.record,
    );
    expect(pinned?.state).toMatchObject({ checkpoint: { phase: 'summarize' } });
    expect(
      await runInDurableObject(original, async (instance) => {
        const probe = instance as unknown as import('./byok-entry').BYOKProbe;
        return (await (await probe.harness.pi()).snapshot(ExecutionScope, firstScope, BG))!.rounds;
      }),
    ).toContain(Number(pinned!.id));
    await store.save('fixture', {
      apiKey: 'key-second',
      baseUrl: 'https://second.example.com/v1',
      expectedCurrentId: first.currentId,
    });
    await original.submitRun({
      runId: crypto.randomUUID(),
      text: 'newer during background',
      config: { provider: 'fixture', modelId: 'fixture-pro', thinkingLevel: 'high' },
    });
    await settle(original);
    await abortAllDurableObjects();
    const stub = (env.BYOK_PROBES as any).get(original.id);
    await settle(stub);
    await expect
      .poll(async () => await stub.compactions())
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ version: 'first', base_url: 'https://first.example.com/v1' }),
        ]),
      );
    await expect
      .poll(async () =>
        runInDurableObject(
          stub,
          async (instance) =>
            (await (await (instance as any).harness.pi()).getTask(pinned!.id, BG))?.state,
        ),
      )
      .toMatchObject({ status: 'terminal', outcome: { status: 'completed' } });
    await runInDurableObject(stub, async (instance) => {
      const probe = instance as unknown as import('./byok-entry').BYOKProbe;
      const pi = await probe.harness.pi(),
        root = await probe.root();
      expect((await pi.snapshot(ConversationPolicy, String(root.id), BG))!.scope).not.toBe(
        firstScope,
      );
      expect(
        (await pi.snapshot(ExecutionScope, firstScope, BG))!.rounds.filter(
          (id) => id === Number(pinned!.id),
        ),
      ).toHaveLength(1);
    });
    expect(
      (await stub.calls()).some(
        (call: { model: string; version: string }) =>
          call.model === 'fixture-pro' && call.version === 'second',
      ),
    ).toBe(true);
  } finally {
    release();
  }
});

it.each([false, true])(
  'restores a committed real D1 credential checkpoint without fallback (revoked=%s)',
  async (revoked) => {
    const { store, stub: original } = await fixture();
    const first = await store.save('fixture', {
      apiKey: 'key-first',
      baseUrl: 'https://first.example.com/v1',
      expectedCurrentId: null,
    });
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await runInDurableObject(original, (instance) => {
      const probe = instance as unknown as { credentials(): Promise<CredentialAccess> };
      const originalCredentials = probe.credentials.bind(instance);
      let once = true;
      probe.credentials = async () => {
        const credentials = await originalCredentials();
        return {
          select: credentials.select.bind(credentials),
          resolve: async (...args: Parameters<typeof credentials.resolve>) => {
            if (once) {
              once = false;
              entered = true;
              await gate;
            }
            return credentials.resolve(...args);
          },
        };
      };
    });
    const a = crypto.randomUUID(),
      b = crypto.randomUUID();
    try {
      await original.submitRun({ runId: a, text: 'prepared first' });
      await expect.poll(() => entered).toBe(true); // auth resolves after native request checkpoint
      const second = await store.save('fixture', {
        apiKey: 'key-second',
        baseUrl: 'https://second.example.com/v1',
        expectedCurrentId: first.currentId,
      });
      await original.submitRun({
        runId: b,
        text: 'queued second',
        config: { provider: 'fixture', modelId: 'fixture-pro', thinkingLevel: 'high' },
      });
      if (revoked) {
        await store.remove('fixture', second.currentId);
        await store.save('fixture', { apiKey: 'key-third', expectedCurrentId: null });
      }
      await abortAllDurableObjects();
      const stub = (env.BYOK_PROBES as any).get(original.id);
      await settle(stub);
      const calls = await stub.calls();
      if (revoked) {
        expect(calls).toEqual([]);
        expect(await stub.submission(a)).toMatchObject({
          status: 'unanswered',
          reason: 'model_error',
        });
      } else {
        expect(calls).toEqual([
          { model: 'fixture', version: 'first', base_url: 'https://first.example.com/v1' },
          { model: 'fixture-pro', version: 'second', base_url: 'https://second.example.com/v1' },
        ]);
        expect(await stub.submission(a)).toMatchObject({ status: 'done' });
        expect(await stub.submission(b)).toMatchObject({ status: 'done' });
      }
    } finally {
      release();
    }
  },
);

it('rolls a configure/submit acceptance gap forward before a newer configuration update', async () => {
  const { store, stub } = await fixture();
  const first = await store.save('fixture', { apiKey: 'key-first', expectedCurrentId: null });
  await beforeNative(stub, 'fixture_configure_submit_gap', true);
  const a = { runId: crypto.randomUUID(), text: 'older configuration' };
  expect(await stub.submitRun(a)).toMatchObject({
    error: { code: 'fixture_configure_submit_gap' },
  });
  await store.save('fixture', { apiKey: 'key-second', expectedCurrentId: first.currentId });
  const b = {
    runId: crypto.randomUUID(),
    text: 'newer configuration',
    config: { provider: 'fixture', modelId: 'fixture-pro', thinkingLevel: 'high' as const },
  };
  expect(await stub.submitRun(b)).toMatchObject({ accepted: true });
  expect(await stub.submitRun(a)).toMatchObject({ accepted: true });
  await settle(stub);
  expect(
    await stub.submitRun({
      runId: crypto.randomUUID(),
      text: 'latest unchanged',
      config: b.config,
    }),
  ).toMatchObject({ accepted: true });
  await settle(stub);
  const calls = await stub.calls();
  expect(calls.at(-1)).toMatchObject({ model: 'fixture-pro', version: 'second' });
  expect(await receipt(stub, a.runId)).toMatchObject({ state: 'admitted' });
  expect(await receipt(stub, b.runId)).toMatchObject({ state: 'admitted' });
});

it('restores history after Stop withdraws a configured request before native acceptance', async () => {
  const { store, stub: original } = await fixture();
  const first = await store.save('fixture', { apiKey: 'key-first', expectedCurrentId: null });
  const completed = crypto.randomUUID();
  await original.submitRun({ runId: completed, text: 'completed history' });
  await settle(original);
  await store.save('fixture', { apiKey: 'key-second', expectedCurrentId: first.currentId });
  await beforeNative(original, 'fixture_configure_submit_gap');
  const withdrawn = crypto.randomUUID();
  expect(
    await original.submitRun({ runId: withdrawn, text: 'withdraw before acceptance' }),
  ).toMatchObject({ error: { code: 'fixture_configure_submit_gap' } });
  await original.stopConversation();
  await expect.poll(async () => (await settle(original)).stopping).toBe(false);
  await store.remove('fixture', (await store.metadata('fixture')).currentId);
  await abortAllDurableObjects();
  const restored = (env.BYOK_PROBES as any).get(original.id);
  expect(JSON.stringify(await settle(restored))).toContain('completed history');
  expect((await restored.submission(completed))!.status).toBe('done');
  expect(
    await restored.submitRun({ runId: withdrawn, text: 'withdraw before acceptance' }),
  ).toMatchObject({ error: { code: 'request_withdrawn' } });
  await store.save('fixture', { apiKey: 'key-third', expectedCurrentId: null });
  const next = crypto.randomUUID();
  expect(await restored.submitRun({ runId: next, text: 'after stopped gap' })).toMatchObject({
    accepted: true,
  });
  await settle(restored);
  expect(await restored.calls()).toEqual([
    expect.objectContaining({ version: 'first' }),
    expect.objectContaining({ version: 'third' }),
  ]);
});
