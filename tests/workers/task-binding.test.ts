import { env, abortAllDurableObjects } from 'cloudflare:test';
import { expect, it } from 'vitest';

const probes = (env as unknown as { BINDING_PROBES: DurableObjectNamespace }).BINDING_PROBES;
const fresh = (): any => probes.getByName(crypto.randomUUID());
const providers = (o: any) =>
  o.log.filter((r: any) => r.event === 'provider').map((r: any) => r.data);
async function until(stub: any, condition: (o: any) => boolean) {
  for (let i = 0; i < 350; i++) {
    const observation = await stub.observation();
    if (condition(observation)) return observation;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Step configuration probe did not reach the expected boundary');
}
const entered = (event: string) => (o: any) => o.log.some((r: any) => r.event === event);

it('selects the native model before prompt and context-window checks, including blocking compaction', async () => {
  const stub = fresh();
  await stub.seed();
  await stub.submit('A', 'plain-A', 'k1');
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
});

it('uses the latest configuration for tool successors and queued inputs after real DO reconstruction', async () => {
  let stub = fresh();
  await stub.submit('A', 'tool-A', 'k1');
  await until(stub, entered('tool-enter'));
  await stub.submit('B', 'plain-B', 'k2');
  await stub.submit('C', 'plain-C', 'k3');
  const before = await stub.observation();
  const id = stub.id;
  await abortAllDurableObjects();
  stub = probes.get(id);
  expect((await stub.observation()).instanceId).not.toBe(before.instanceId);
  await stub.release('tool');
  const o = await until(stub, (o) => !o.pending.length);
  expect(providers(o).map((p: any) => [p.user, p.version])).toEqual([
    ['tool-A', 'k1'],
    ['tool-A', 'k3'],
    ['plain-B', 'k3'],
    ['plain-C', 'k3'],
  ]);
  expect(providers(o).every((p: any) => p.keyMatches)).toBe(true);
  expect(await stub.submit('B', 'plain-B', 'k1')).toMatchObject({ accepted: false });
  expect(providers(await stub.observation())).toHaveLength(4);
  expect(await stub.persistedHasCanary()).toBe(false);
});

it('re-prepares with current configuration when interrupted before a request checkpoint', async () => {
  let stub = fresh();
  await stub.mode('gate-prepare');
  await stub.submit('A', 'plain-A', 'k1');
  const before = await until(stub, entered('prepare-agent'));
  expect(providers(before)).toHaveLength(0);
  await stub.set('k3');
  await stub.mode('gate-prepare', false);
  await abortAllDurableObjects();
  stub = probes.get(stub.id);
  const o = await until(stub, (o) => !o.pending.length);
  expect(o.instanceId).not.toBe(before.instanceId);
  expect(providers(o)).toEqual([
    expect.objectContaining({ version: 'k3', thinking: 'low', keyMatches: true }),
  ]);
});

it('restores a committed request checkpoint with its original model, effort and immutable key', async () => {
  let stub = fresh();
  await stub.mode('gate-request');
  await stub.submit('A', 'plain-A', 'k1');
  await until(stub, entered('request-ready'));
  await stub.set('k3');
  await stub.mode('gate-request', false);
  await abortAllDurableObjects();
  stub = probes.get(stub.id);
  const o = await until(stub, (o) => !o.pending.length);
  expect(providers(o)).toEqual([
    expect.objectContaining({ version: 'k1', thinking: 'high', keyMatches: true }),
  ]);
});

it('does not fall back after a checkpoint credential is revoked and DO is reconstructed', async () => {
  let stub = fresh();
  await stub.mode('gate-request');
  await stub.submit('A', 'plain-A', 'k1');
  await until(stub, entered('request-ready'));
  await stub.set('k3');
  await stub.disable('k1');
  await stub.mode('gate-request', false);
  await abortAllDurableObjects();
  stub = probes.get(stub.id);
  const o = await until(stub, (o) => !o.pending.length);
  expect(providers(o)).toEqual([]);
  expect(await stub.operation('A')).toMatchObject({ status: 'unanswered', reason: 'model_error' });
});

it('selects current configuration for compaction which has not committed selection', async () => {
  const stub = fresh();
  const before = await stub.nativePausedCompaction();
  expect(before.input).toEqual({ reason: 'manual' });
  expect(providers(await stub.observation()).find((p: any) => p.summary)).toMatchObject({
    version: 'k2',
    thinking: 'low',
    keyMatches: true,
  });
});

it('preserves a committed background summary checkpoint across config changes and DO reconstruction', async () => {
  let stub = fresh();
  await stub.mode('gate-summary');
  await stub.seed(80000);
  await stub.submit('A', 'plain-A', 'k1');
  const before = await until(
    stub,
    (o) => providers(o).some((p: any) => p.summary) && !o.pending.length,
  );
  await stub.submit('B', 'plain-B', 'k2');
  await until(stub, (o) => !o.pending.length);
  await stub.mode('gate-summary', false);
  await abortAllDurableObjects();
  stub = probes.get(stub.id);
  const o = await until(
    stub,
    (o) => !o.tasks.some((t: any) => t.kind === 'pi.compaction' && t.state.status !== 'terminal'),
  );
  expect(o.instanceId).not.toBe(before.instanceId);
  expect(
    providers(o)
      .filter((p: any) => p.summary)
      .every((p: any) => p.version === 'k1' && p.keyMatches),
  ).toBe(true);
  expect(providers(o).find((p: any) => p.user === 'plain-B')).toMatchObject({ version: 'k2' });
});

it('uses the latest config when native generation retry re-enters prepare', async () => {
  let stub = fresh();
  await stub.mode('retry-enabled');
  await stub.mode('long-retry');
  await stub.submit('A', 'retry-A', 'k1');
  await until(stub, (o) => o.tasks.some((t: any) => t.state.checkpoint?.phase === 'retry'));
  await stub.set('k2');
  await abortAllDurableObjects();
  stub = probes.get(stub.id);
  const o = await until(stub, (o) => !o.pending.length);
  expect(providers(o).map((p: any) => p.version)).toEqual(['k1', 'k2']);
  expect(await stub.operation('A')).toMatchObject({ status: 'done' });
});

it('Stop withdraws queued inputs and does not dispatch their tools', async () => {
  const stub = fresh();
  await stub.submit('A', 'tool-A', 'k1');
  await until(stub, entered('tool-enter'));
  await stub.submit('B', 'plain-B', 'k2');
  await stub.stop();
  await until(stub, (o) => !o.pending.length);
  expect(await stub.operation('A')).toMatchObject({ status: 'unanswered', reason: 'aborted' });
  expect(await stub.operation('B')).toMatchObject({ status: 'unanswered', reason: 'aborted' });
  expect(providers(await stub.observation())).toHaveLength(1);
});

it('uses current native configuration for onYield continuations and overflow compaction', async () => {
  const stub = fresh();
  await stub.submit('A', 'yield-A', 'k1');
  const p = providers(await until(stub, (o) => !o.pending.length));
  expect(p.map((p: any) => [p.user, p.version])).toEqual([
    ['yield-A', 'k1'],
    ['yield-next', 'k1'],
  ]);
  await stub.seed(20000);
  await stub.submit('B', 'overflow-A', 'k1');
  const after = providers(await until(stub, (o) => !o.pending.length));
  expect(after.some((p: any) => p.summary)).toBe(true);
  expect(after.every((p: any) => p.version === 'k1' && p.keyMatches)).toBe(true);
});

it('does not substitute a default when the configured provider is missing', async () => {
  const stub = fresh();
  await stub.configure({ provider: 'removed-provider', modelId: 'small', thinkingLevel: 'high' });
  await stub.submitDraft({ type: 'input', requestId: 'removed', content: 'plain' });
  const o = await until(stub, (o) => !o.pending.length);
  expect(await stub.operation('removed')).toMatchObject({
    status: 'unanswered',
    reason: 'no_model',
  });
  expect(providers(o)).toHaveLength(0);
});

it('retains the summary checkpoint when compaction retries after a configuration change and DO reconstruction', async () => {
  let stub = fresh();
  await stub.mode('retry-enabled');
  await stub.mode('long-retry');
  await stub.mode('retry-summary');
  await stub.seed();
  await stub.submit('A', 'plain-A', 'k1');
  await until(stub, (o) =>
    o.tasks.some((t: any) => t.kind === 'pi.compaction' && t.state.checkpoint?.phase === 'retry'),
  );
  await stub.set('k2');
  await abortAllDurableObjects();
  stub = probes.get(stub.id);
  const o = await until(stub, (o) => !o.pending.length);
  const summaries = providers(o).filter((p: any) => p.summary);
  expect(summaries).toHaveLength(2);
  expect(
    summaries.every((p: any) => p.version === 'k1' && p.thinking === 'high' && p.keyMatches),
  ).toBe(true);
  expect(providers(o).find((p: any) => !p.summary)).toMatchObject({ version: 'k2' });
});
