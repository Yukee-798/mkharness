import { env, abortAllDurableObjects, runInDurableObject } from 'cloudflare:test';
import { it, expect } from 'vitest';
import { ModelCredentials } from '../../src/server/models/credentials';
import { AppError } from '../../src/shared/contracts';
import type { CredentialAccess } from '../../src/server/models/execution';
import type { PiHarness } from 'agents/harness/pi';
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
    'INSERT INTO conversations(id,owner,title,created_at,updated_at) VALUES(?,?,?,?,?)',
  )
    .bind(chat, owner, 'binding', now, now)
    .run();
  const store = new ModelCredentials(env, owner);
  return { store, stub: (env as any).BYOK_PROBES.getByName(chat) };
}
async function settle(stub: any) {
  for (let i = 0; i < 300; i++) {
    const s = JSON.parse(await stub.snapshot());
    if (!s.pending.length) return s;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error('queue timeout');
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
  const stub = (env as any).BYOK_PROBES.get(original.id);
  expect(JSON.stringify(await settle(stub))).toContain('completed on removed model');
  expect((await stub.submission(runId)).status).toBe('done');
  const next = crypto.randomUUID();
  expect(await stub.submitRun({ runId: next, text: 'remaining model' })).toMatchObject({
    accepted: true,
  });
  await settle(stub);
  expect((await stub.submission(next)).status).toBe('done');
});
it('settles a host acceptance gap with no_model after catalog removal while retaining history and Stop', async () => {
  const { store, stub: original } = await fixture();
  await store.save('fixture', { apiKey: 'key-original', expectedCurrentId: null });
  await runInDurableObject(original, (instance) => {
    const probe = instance as unknown as { harness: PiHarness; reconcile(): Promise<void> };
    probe.reconcile = async () => {};
    probe.harness.submit = async () => {
      throw new AppError(503, 'fixture_before_native_acceptance');
    };
  });
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
  const stub = (env as any).BYOK_PROBES.get(original.id);
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
it('withdraws an idle follower on cold start even when its model was removed', async () => {
  const { store, stub: original } = await fixture();
  await store.save('fixture', { apiKey: 'key-original', expectedCurrentId: null });
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await runInDurableObject(original, (instance) => {
    const probe = instance as unknown as {
      credentials(): Promise<CredentialAccess>;
      reconcile(): Promise<void>;
    };
    const credentials = probe.credentials.bind(instance);
    let first = true;
    // Preserve the native failed-run/queued-input gap until actual eviction.
    probe.reconcile = async () => {};
    probe.credentials = async () => {
      const access = await credentials();
      return {
        select: access.select.bind(access),
        resolve: async (...args: Parameters<typeof access.resolve>) => {
          if (!first) return access.resolve(...args);
          first = false;
          entered = true;
          await gate;
          throw new AppError(503, 'fixture_failure');
        },
      };
    };
  });
  const a = crypto.randomUUID(),
    b = crypto.randomUUID();
  try {
    await original.submitRun({ runId: a, text: 'failed parent' });
    await expect.poll(() => entered).toBe(true);
    await original.submitRun({
      runId: b,
      text: 'unexecuted removed follower',
      config: { provider: 'fixture', modelId: 'fixture-pro', thinkingLevel: 'high' },
    });
    release();
    await expect.poll(async () => (await original.submission(a)).status).toBe('unanswered');
    expect((await original.submission(b)).status).toBe('queued');
    await runInDurableObject(original, (_instance, state) => {
      state.storage.sql.exec('CREATE TABLE test_removed_model(id TEXT)');
      state.storage.sql.exec('INSERT INTO test_removed_model VALUES(?)', 'fixture-pro');
    });
    await abortAllDurableObjects();
    const stub = (env as any).BYOK_PROBES.get(original.id);
    const snapshot = await settle(stub);
    expect(snapshot.pending).toEqual([]);
    expect(JSON.stringify(snapshot.entries)).not.toContain('unexecuted removed follower');
    expect(await stub.submission(b)).toMatchObject({ status: 'unanswered', reason: 'aborted' });
    const next = crypto.randomUUID();
    expect(await stub.submitRun({ runId: next, text: 'remaining model' })).toMatchObject({
      accepted: true,
    });
    await settle(stub);
    expect((await stub.submission(next)).status).toBe('done');
    expect(await stub.stopConversation()).toMatchObject({ stopping: true });
  } finally {
    release();
  }
});
it('reconciles an already completed native receipt without its removed model or resubmission', async () => {
  const { store, stub: original } = await fixture();
  await store.save('fixture', { apiKey: 'key-original', expectedCurrentId: null });
  await runInDurableObject(original, (instance) => {
    const probe = instance as unknown as { harness: PiHarness; reconcile(): Promise<void> };
    const submit = probe.harness.submit.bind(probe.harness);
    probe.reconcile = async () => {};
    probe.harness.submit = async (...args: Parameters<typeof submit>) => {
      await submit(...args);
      throw new AppError(503, 'fixture_lost_acceptance_ack');
    };
  });
  const request = {
    runId: crypto.randomUUID(),
    text: 'completed before host receipt',
    config: { provider: 'fixture', modelId: 'fixture-pro', thinkingLevel: 'high' as const },
  };
  expect(await original.submitRun(request)).toMatchObject({
    error: { code: 'fixture_lost_acceptance_ack' },
  });
  await expect.poll(async () => (await original.submission(request.runId)).status).toBe('done');
  const calls = await original.calls();
  await runInDurableObject(original, (_instance, state) => {
    expect(
      state.storage.sql.exec('SELECT accepted FROM app_requests WHERE id=?', request.runId).one()
        .accepted,
    ).toBe(0);
    state.storage.sql.exec('CREATE TABLE test_removed_model(id TEXT)');
    state.storage.sql.exec('INSERT INTO test_removed_model VALUES(?)', 'fixture-pro');
  });
  await abortAllDurableObjects();
  const stub = (env as any).BYOK_PROBES.get(original.id);
  const snapshot = await settle(stub);
  expect(JSON.stringify(snapshot.entries)).toContain('completed before host receipt');
  expect(await stub.submitRun(request)).toMatchObject({ accepted: true });
  await expect
    .poll(async () =>
      runInDurableObject(
        stub,
        (_instance, state) =>
          state.storage.sql
            .exec('SELECT accepted FROM app_requests WHERE id=?', request.runId)
            .one().accepted,
      ),
    )
    .toBe(1);
  expect(await stub.calls()).toEqual(calls);
  const after = await settle(stub);
  expect(after.entries).toEqual(snapshot.entries);
  expect((await stub.submission(request.runId)).status).toBe('done');
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
  const third = await store.save('fixture', {
    apiKey: 'key-third',
    baseUrl: 'https://third.example.com/v1',
    expectedCurrentId: second.currentId,
  });
  const c = { runId: crypto.randomUUID(), text: 'third', config: b.config };
  expect(await stub.submitRun(c)).toMatchObject({ accepted: true });
  expect(await stub.submitRun(b)).toMatchObject({ accepted: true });
  await abortAllDurableObjects();
  stub = (env as any).BYOK_PROBES.get(stub.id);
  const snapshot = await settle(stub);
  const records = await runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec('SELECT payload FROM app_requests ORDER BY rowid').toArray(),
  );
  expect(records.map((r: any) => JSON.parse(r.payload).execution.credentialRef.id)).toEqual([
    first.currentId,
    second.currentId,
    third.currentId,
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
    await stub.submitRun({ runId: crypto.randomUUID(), text: 'hello', apiKey: 'forged' }),
  ).toMatchObject({ error: { code: 'invalid_request' } });
});
it('uses real D1 credential snapshots for blocking and overlapping background compaction', async () => {
  const { store } = await fixture();
  const first = await store.save('fixture', {
    apiKey: 'CANARY-NONSECRET-k1',
    baseUrl: 'https://first.example.com/v1',
    expectedCurrentId: null,
  });
  const refs = { k1: { source: 'user', id: first.currentId } };
  async function until(probe: any, predicate: (o: any) => boolean) {
    for (let i = 0; i < 500; i++) {
      const o = await probe.observation();
      if (predicate(o)) return o;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('compaction boundary timeout');
  }
  // Probe executes the actual native prepare/checkpoint/compaction graph; only supplier I/O is synthetic.
  const owner = await env.DB.prepare('SELECT owner FROM model_credentials WHERE id=?')
    .bind(first.currentId)
    .first<string>('owner');
  const blocking = (env as any).BINDING_PROBES.getByName(crypto.randomUUID());
  await blocking.useD1Credentials(owner, refs);
  await blocking.seed();
  await blocking.submit('A', 'plain-A', 'k1');
  const done = await until(
    blocking,
    (o) => !o.pending.length && o.log.some((r: any) => r.event === 'provider' && r.data.summary),
  );
  expect(
    done.log
      .filter((r: any) => r.event === 'provider')
      .every(
        (r: any) =>
          r.data.version === 'k1' &&
          r.data.keyMatches &&
          r.data.baseUrl === 'https://first.example.com/v1',
      ),
  ).toBe(true);
  const background = (env as any).BINDING_PROBES.getByName(crypto.randomUUID());
  await background.useD1Credentials(owner, refs);
  await background.mode('gate-compact');
  await background.seed(80000);
  await background.submit('A', 'plain-A', 'k1');
  await until(
    background,
    (o) => !o.pending.length && o.log.some((r: any) => r.event === 'compact-selected'),
  );
  const second = await store.save('fixture', {
    apiKey: 'CANARY-NONSECRET-k2',
    baseUrl: 'https://second.example.com/v1',
    expectedCurrentId: first.currentId,
  });
  await background.useD1Credentials(owner, {
    ...refs,
    k2: { source: 'user', id: second.currentId },
  });
  await background.submit('B', 'plain-B', 'k2', true);
  await until(background, (o) => !o.pending.length);
  await background.release('compact');
  const after = await until(background, (o) =>
    o.log.some((r: any) => r.event === 'provider' && r.data.summary),
  );
  expect(after.log.find((r: any) => r.event === 'provider' && r.data.summary).data).toMatchObject({
    version: 'k1',
    baseUrl: 'https://first.example.com/v1',
    keyMatches: true,
    thinking: 'high',
  });
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
      const stub = (env as any).BYOK_PROBES.get(original.id);
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
  await runInDurableObject(stub, (instance) => {
    const probe = instance as unknown as { harness: PiHarness; reconcile(): Promise<void> };
    probe.reconcile = async () => {};
    const submit = probe.harness.submit.bind(probe.harness);
    let once = true;
    probe.harness.submit = async (...args: Parameters<typeof submit>) => {
      if (once) {
        once = false;
        throw new AppError(503, 'fixture_configure_submit_gap');
      }
      return submit(...args);
    };
  });
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
  expect(
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec('SELECT accepted FROM app_requests ORDER BY rowid').toArray(),
    ),
  ).toEqual([{ accepted: 1 }, { accepted: 1 }, { accepted: 1 }]);
});

it('restores history after Stop withdraws a configured request before native acceptance', async () => {
  const { store, stub: original } = await fixture();
  const first = await store.save('fixture', { apiKey: 'key-first', expectedCurrentId: null });
  const completed = crypto.randomUUID();
  await original.submitRun({ runId: completed, text: 'completed history' });
  await settle(original);
  await store.save('fixture', { apiKey: 'key-second', expectedCurrentId: first.currentId });
  await runInDurableObject(original, (instance) => {
    const probe = instance as unknown as { harness: PiHarness; reconcile(): Promise<void> };
    probe.reconcile = async () => {};
    probe.harness.submit = async () => {
      throw new AppError(503, 'fixture_configure_submit_gap');
    };
  });
  const withdrawn = crypto.randomUUID();
  expect(
    await original.submitRun({ runId: withdrawn, text: 'withdraw before acceptance' }),
  ).toMatchObject({ error: { code: 'fixture_configure_submit_gap' } });
  await original.stopConversation();
  await expect.poll(async () => (await settle(original)).stopping).toBe(false);
  await store.remove('fixture', (await store.metadata('fixture')).currentId);
  await abortAllDurableObjects();
  const restored = (env as any).BYOK_PROBES.get(original.id);
  expect(JSON.stringify(await settle(restored))).toContain('completed history');
  expect((await restored.submission(completed)).status).toBe('done');
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
