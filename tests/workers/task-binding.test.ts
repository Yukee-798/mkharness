import { env, abortAllDurableObjects } from 'cloudflare:test';
import { expect, it } from 'vitest';

const probes = (env as unknown as { BINDING_PROBES: DurableObjectNamespace }).BINDING_PROBES;
const fresh = (): any => probes.getByName(crypto.randomUUID());
const providers = (o: any) =>
  o.log.filter((r: any) => r.event === 'provider').map((r: any) => r.data);
async function until(stub: ReturnType<typeof fresh>, condition: (o: any) => boolean) {
  for (let i = 0; i < 350; i++) {
    const observation = await stub.observation();
    if (condition(observation)) return observation;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Binding probe did not reach the expected boundary');
}

it('binds prepare and provider before window checking, including blocking compaction', async () => {
  const stub = fresh();
  await stub.seed();
  await stub.submit('A', 'plain-A', 'k1'); // shared default remains k3/100k
  const o = await until(stub, (o) => !o.pending.length);
  expect(o.log.find((r: any) => r.event === 'prepare-agent').data).toMatchObject({
    model: { provider: 'canary-k1', modelId: 'small' },
    thinking: 'high',
  });
  expect(providers(o).find((p: any) => p.summary)).toMatchObject({
    version: 'k1',
    contextWindow: 32000,
    thinking: 'high',
    keyMatches: true,
  });
  expect(providers(o).find((p: any) => !p.summary)).toMatchObject({ version: 'k1' });
});

it('preserves each queued binding, successor rounds and receipt after real DO reconstruction', async () => {
  let stub = fresh();
  await stub.submit('A', 'tool-A', 'k1');
  await until(stub, (o) => o.log.some((r: any) => r.event === 'tool-enter'));
  await stub.submit('B', 'plain-B', 'k2');
  await stub.submit('C', 'plain-C', 'k3');
  await stub.set('k3');
  const before = await stub.observation();
  const id = stub.id;
  await abortAllDurableObjects();
  stub = probes.get(id);
  expect((await stub.observation()).instanceId).not.toBe(before.instanceId);
  await stub.release('tool');
  const o = await until(stub, (o) => !o.pending.length);
  const p = providers(o);
  expect(p.filter((p: any) => p.user === 'tool-A').map((p: any) => p.version)).toEqual([
    'k1',
    'k1',
  ]);
  expect(p.find((p: any) => p.user === 'plain-B')).toMatchObject({
    version: 'k2',
    thinking: 'low',
    keyMatches: true,
  });
  expect(p.find((p: any) => p.user === 'plain-C')).toMatchObject({
    version: 'k3',
    keyMatches: true,
  });
  expect(await stub.submit('B', 'plain-B', 'k3')).toMatchObject({ accepted: false });
  expect(providers(await stub.observation())).toHaveLength(p.length);
  expect(await stub.persistedHasCanary()).toBe(false);
});

it('preserves accepted binding when interrupted before the first prepare checkpoint', async () => {
  let stub = fresh();
  await stub.mode('gate-prepare');
  await stub.submit('A', 'plain-A', 'k1');
  const before = await until(stub, (o) => o.log.some((r: any) => r.event === 'prepare-agent'));
  expect(providers(before)).toHaveLength(0);
  await stub.set('k3');
  await stub.mode('gate-prepare', false);
  const id = stub.id;
  await abortAllDurableObjects();
  stub = probes.get(id);
  const o = await until(stub, (o) => !o.pending.length);
  expect(o.instanceId).not.toBe(before.instanceId);
  expect(providers(o)).toEqual([
    expect.objectContaining({ version: 'k1', thinking: 'high', keyMatches: true }),
  ]);
});

it('inherits background compaction binding after another queued operation changes the default', async () => {
  const stub = fresh();
  await stub.mode('gate-compact');
  await stub.seed(80000);
  await stub.submit('A', 'plain-A', 'k1');
  await until(
    stub,
    (o) => o.log.some((r: any) => r.event === 'compact-selected') && !o.pending.length,
  );
  await stub.submit('B', 'plain-B', 'k2', true);
  await until(stub, (o) => !o.pending.length);
  await stub.release('compact');
  const o = await until(stub, (o) => providers(o).some((p: any) => p.summary));
  expect(providers(o).find((p: any) => p.summary)).toMatchObject({
    version: 'k1',
    thinking: 'high',
    keyMatches: true,
  });
});

it('pins manual compaction before its select phase', async () => {
  const stub = fresh();
  const task = await stub.nativePausedCompaction();
  expect(task.input).toMatchObject({ execution: { model: { provider: 'canary-k1' } } });
  expect(providers(await stub.observation()).find((p: any) => p.summary)).toMatchObject({
    version: 'k1',
    keyMatches: true,
  });
});

it('fails explicitly when a bound credential version is missing after reconstruction', async () => {
  let stub = fresh();
  await stub.submit('A', 'tool-A', 'k1');
  await until(stub, (o) => o.log.some((r: any) => r.event === 'tool-enter'));
  await stub.disable('k1');
  const id = stub.id;
  await abortAllDurableObjects();
  stub = probes.get(id);
  await stub.release('tool');
  const o = await until(stub, (o) => !o.pending.length);
  expect(providers(o)).toHaveLength(1);
  expect(await stub.operation('A')).toMatchObject({ status: 'unanswered', reason: 'model_error' });
  expect(await stub.persistedHasCanary()).toBe(false);
});

it('retains queued configuration even when a prior model error skips onYield', async () => {
  const stub = fresh();
  await stub.submit('A', 'tool-A error-A', 'k1');
  await until(stub, (o) => o.log.some((r: any) => r.event === 'tool-enter'));
  await stub.submit('B', 'plain-B', 'k2');
  await stub.release('tool');
  expect(await stub.operation('A')).toMatchObject({ status: 'unanswered', reason: 'model_error' });
  // Preserve native error-queue behavior: C wakes the existing queue; no host scheduler.
  await stub.submit('C', 'plain-C', 'k3');
  const o = await until(stub, (o) => !o.pending.length);
  expect(providers(o).find((p: any) => p.user === 'plain-B')).toMatchObject({
    version: 'k2',
    keyMatches: true,
  });
});

it('does not combine different bindings when followUpMode is all', async () => {
  const stub = fresh();
  await stub.mode('all-followups');
  await stub.submit('A', 'tool-A', 'k1');
  await until(stub, (o) => o.log.some((r: any) => r.event === 'tool-enter'));
  await stub.submit('B', 'plain-B', 'k2');
  await stub.submit('C', 'plain-C', 'k3');
  await stub.release('tool');
  const p = providers(await until(stub, (o) => !o.pending.length));
  expect(p.find((p: any) => p.user === 'plain-B')).toMatchObject({ version: 'k2' });
  expect(p.find((p: any) => p.user === 'plain-C')).toMatchObject({ version: 'k3' });
});

it('rejects raw credentials and bound steering before admitting another input', async () => {
  const stub = fresh();
  const execution = { model: { provider: 'canary-k1', modelId: 'small' }, thinkingLevel: 'high' };
  await expect(
    stub.submitDraft({
      type: 'input',
      requestId: 'invalid',
      content: 'plain',
      execution: { ...execution, apiKey: 'never persist' },
    }),
  ).resolves.toEqual({ error: 'Invalid submission execution binding' });
  await stub.submit('A', 'tool-A', 'k1');
  await until(stub, (o) => o.log.some((r: any) => r.event === 'tool-enter'));
  await expect(
    stub.submitDraft({
      type: 'input',
      requestId: 'steer',
      content: 'plain',
      whenBusy: 'steer',
      execution,
    }),
  ).resolves.toEqual({ error: 'Bound submissions must use followUp or reject' });
  const o = await stub.observation();
  expect(o.submissions).toHaveLength(1);
  await stub.stop();
});

it('Stop withdraws bound queued inputs without activating their configurations', async () => {
  const stub = fresh();
  await stub.submit('A', 'tool-A', 'k1');
  await until(stub, (o) => o.log.some((r: any) => r.event === 'tool-enter'));
  await stub.submit('B', 'plain-B', 'k2');
  await stub.stop();
  await until(stub, (o) => !o.pending.length);
  expect(await stub.operation('A')).toMatchObject({ status: 'unanswered', reason: 'aborted' });
  expect(await stub.operation('B')).toMatchObject({ status: 'unanswered', reason: 'aborted' });
  expect(providers(await stub.observation()).some((p: any) => p.version === 'k2')).toBe(false);
});

it('supports an explicitly bound public manual compaction independent of the default', async () => {
  const stub = fresh();
  await stub.seed();
  await stub.set('k3');
  await stub.compact('k1');
  const o = await until(stub, (o) => providers(o).some((p: any) => p.summary));
  expect(providers(o).find((p: any) => p.summary)).toMatchObject({
    version: 'k1',
    thinking: 'high',
    keyMatches: true,
  });
});
it('rejects bound steering also while idle, so it cannot be consumed by another run later', async () => {
  const stub = fresh();
  await expect(
    stub.submitDraft({
      type: 'input',
      content: 'plain',
      whenBusy: 'steer',
      execution: { model: { provider: 'canary-k1', modelId: 'small' }, thinkingLevel: 'high' },
    }),
  ).resolves.toEqual({ error: 'Bound submissions must use followUp or reject' });
  expect((await stub.observation()).submissions).toHaveLength(0);
});

it('keeps execution on native onYield continuations', async () => {
  const stub = fresh();
  await stub.submit('A', 'yield-A', 'k1');
  const p = providers(await until(stub, (o) => !o.pending.length));
  expect(p.map((p: any) => [p.user, p.version, p.thinking])).toEqual([
    ['yield-A', 'k1', 'high'],
    ['yield-next', 'k1', 'high'],
  ]);
});

it('keeps execution when native retry re-enters prepare', async () => {
  const stub = fresh();
  await stub.mode('retry-enabled');
  await stub.submit('A', 'retry-A', 'k1');
  const p = providers(await until(stub, (o) => !o.pending.length));
  expect(p.map((p: any) => p.version)).toEqual(['k1', 'k1']);
  expect(await stub.operation('A')).toMatchObject({ status: 'done' });
});

it('inherits execution into overflow compaction and its resumed generation', async () => {
  const stub = fresh();
  await stub.seed(20000);
  await stub.submit('A', 'overflow-A', 'k1');
  const p = providers(await until(stub, (o) => !o.pending.length));
  expect(p.some((p: any) => p.summary)).toBe(true);
  expect(p.every((p: any) => p.version === 'k1' && p.thinking === 'high' && p.keyMatches)).toBe(
    true,
  );
  expect(await stub.operation('A')).toMatchObject({ status: 'done' });
});

it('does not fall back to a default when the persisted provider no longer exists', async () => {
  const stub = fresh();
  await stub.submitDraft({
    type: 'input',
    requestId: 'removed',
    content: 'plain',
    execution: {
      model: { provider: 'removed-provider', modelId: 'small' },
      thinkingLevel: 'high',
    },
  });
  const o = await until(stub, (o) => !o.pending.length);
  expect(await stub.operation('removed')).toMatchObject({
    status: 'unanswered',
    reason: 'no_model',
  });
  expect(providers(o)).toHaveLength(0);
});
