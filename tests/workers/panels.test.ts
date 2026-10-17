import { env, runInDurableObject } from './env';
import { it, expect } from 'vitest';
import { fixtureModels } from '../fixture-model';
it('commits a bounded large compute result as complete JSON in native Pi history', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const snapshot = await generate(stub, 'large_compute');
  const prepared = snapshot.entries
    .flatMap((entry: any) => entry.model ?? [])
    .find(
      (message: any) => message.role === 'toolResult' && message.toolName === 'prepare_program',
    );
  expect(prepared.isError).toBe(false);
  expect(JSON.parse(prepared.content[0].text).initial).toEqual({ value: 'x'.repeat(65536) });
});
async function generate(stub: ReturnType<typeof env.CONVERSATIONS.getByName>, text = 'panel') {
  await stub.submitRun({ runId: crypto.randomUUID(), text });
  for (let i = 0; i < 600; i++) {
    const s = JSON.parse(await stub.snapshot());
    if (s.pending.length === 0) return s;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Panel did not settle: ' + (await stub.snapshot()));
}
it('publishes from committed tools, preserves raw input and rejects conflicting saves', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const s = await generate(stub);
  const tool = s.entries
    .flatMap((e: any) => e.model ?? [])
    .find((m: any) => m.role === 'toolResult' && m.toolName === 'present_openui' && !m.isError);
  expect(tool).toBeDefined();
  const ref = JSON.parse(tool.content[0].text).panelRef;
  const loaded = JSON.parse(await stub.loadResource('openui', ref));
  expect(loaded.data.program.data).toEqual({ factor: 2 });
  expect(loaded.revision).toBe(0);
  const unrelated = env.CONVERSATIONS.getByName(crypto.randomUUID());
  expect(JSON.parse(await unrelated.loadResource('openui', ref))).toMatchObject({
    error: { status: 404 },
  });
  expect(JSON.parse(await stub.loadResource('unknown', ref))).toMatchObject({
    error: { status: 404 },
  });
  expect(await stub.saveResourceState('openui', ref, {}, -1)).toMatchObject({
    error: { code: 'invalid_revision' },
  });
  expect(
    await stub.saveResourceState('openui', ref, { value: 'x'.repeat(1048576) }, 0),
  ).toMatchObject({ error: { code: 'invalid_state' } });
  expect(await stub.saveResourceState('openui', ref, null, 0)).toMatchObject({
    error: { code: 'invalid_state' },
  });
  expect(await stub.saveResourceState('openui', ref, { $cost: '' }, 0)).toMatchObject({
    revision: 1,
  });
  expect(await stub.saveResourceState('openui', ref, { $cost: '120' }, 0)).toMatchObject({
    error: { status: 409 },
  });
  expect(JSON.parse(await stub.loadResource('openui', ref)).state).toEqual({ $cost: '' });
  expect(await stub.saveResourceState('openui', ref, { $cost: '1.' }, 1)).toMatchObject({
    revision: 2,
  });
  const next = await generate(stub);
  const tools = next.entries
    .flatMap((e: any) => e.model ?? [])
    .filter((m: any) => m.role === 'toolResult' && m.toolName === 'present_openui' && !m.isError);
  const newRef = JSON.parse(tools.at(-1).content[0].text).panelRef;
  expect(newRef).not.toBe(ref);
  expect(JSON.parse(await stub.loadResource('openui', newRef)).revision).toBe(0);
  expect(JSON.parse(await stub.loadResource('openui', ref)).state).toEqual({ $cost: '1.' });
});
it('reads and saves a published resource whose valid component budgets exceed 1 MiB together', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  // Keep this size-boundary fixture within its model window so it tests resources, not compaction.
  await runInDurableObject(stub, (instance) => {
    (instance as any).models = () => fixtureModels(1000000);
  });
  const snapshot = await generate(stub, 'large_panel');
  const published = snapshot.entries
    .flatMap((entry: any) => entry.model ?? [])
    .find(
      (message: any) =>
        message.role === 'toolResult' && message.toolName === 'present_openui' && !message.isError,
    );
  expect(
    published,
    JSON.stringify(
      snapshot.entries
        .flatMap((entry: any) => entry.model ?? [])
        .filter((message: any) => message.role === 'toolResult')
        .map((message: any) => ({
          name: message.toolName,
          error: message.isError,
          content: message.content,
        })),
    ),
  ).toBeDefined();
  const ref = JSON.parse(published.content[0].text).panelRef;
  const loaded = JSON.parse(await stub.loadResource('openui', ref));
  expect(loaded.data.program.data.padding).toHaveLength(900 * 1024);
  expect(loaded.data.ui.length).toBeGreaterThan(200 * 1024);
  expect(await stub.saveResourceState('openui', ref, { $cost: '120' }, 0)).toEqual({ revision: 1 });
  expect(
    await stub.saveResourceState('openui', ref, { value: 'x'.repeat(1048576) }, 1),
  ).toMatchObject({ error: { code: 'invalid_state' } });
});
it('generic resources require an enabled handler and explicit state validation', async () => {
  const target = env.CONVERSATIONS.getByName(crypto.randomUUID());
  await runInDurableObject(target, async (instance) => {
    await instance.root();
    const base = await (instance as any).contributions();
    (instance as any).contributions = async () => [
      ...base,
      {
        id: 'read-only',
        resources: { read: async () => ({ data: { text: 'read' }, initialState: {} }) },
      },
    ];
    expect(JSON.parse(await instance.loadResource('read-only', 'resource'))).toEqual({
      ref: 'resource',
      data: { text: 'read' },
      state: {},
      revision: 0,
    });
    expect(await instance.saveResourceState('read-only', 'resource', {}, 0)).toMatchObject({
      error: { status: 405 },
    });
    (instance as any).contributions = async () => base;
    expect(JSON.parse(await instance.loadResource('read-only', 'resource'))).toMatchObject({
      error: { status: 404 },
    });
  });
});
it('bounds resource data separately from initial and saved state', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  await runInDurableObject(stub, async (instance) => {
    await instance.root();
    const base = await (instance as any).contributions();
    const escaped = {
      data: { text: '\u0001'.repeat(320 * 1024), payload: 'x'.repeat(900 * 1024) },
      initialState: {},
    };
    (instance as any).contributions = async () => [
      ...base,
      { id: 'escaped-resource', resources: { read: async () => escaped } },
    ];
    expect(JSON.parse(await instance.loadResource('escaped-resource', 'ref')).data).toEqual(
      escaped.data,
    );
    for (const value of [
      { data: 'x'.repeat(3 * 1024 * 1024), initialState: {} },
      { data: {}, initialState: 'x'.repeat(1024 * 1024) },
    ]) {
      (instance as any).contributions = async () => [
        ...base,
        { id: 'large-resource', resources: { read: async () => value } },
      ];
      expect(JSON.parse(await instance.loadResource('large-resource', 'ref'))).toMatchObject({
        error: { status: 503, code: 'invalid_resource' },
      });
    }
  });
});
it('refuses a source panel from another chat or an unpublished call', async () => {
  const target = env.CONVERSATIONS.getByName(crypto.randomUUID());
  expect(
    await target.submitRun({
      runId: crypto.randomUUID(),
      text: 'continue',
      source: {
        action: 'extension_action',
        extensionId: 'openui',
        name: 'continue',
        payload: { ref: '2.missing', state: { $cost: '' } },
      },
    }),
  ).toMatchObject({ error: { status: 404 } });
});
it('finishes at committed visual content without another model round, then accepts the next request', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const snapshot = await generate(stub);
  const messages = snapshot.entries.flatMap((entry: any) => entry.model ?? []);
  expect(messages.filter((message: any) => message.role === 'assistant')).toHaveLength(2);
  expect(messages.at(-1)).toMatchObject({
    role: 'toolResult',
    toolName: 'present_openui',
    isError: false,
  });
  await stub.submitRun({ runId: crypto.randomUUID(), text: 'reasoning_trace' });
  for (let i = 0; i < 600; i++) {
    const next = JSON.parse(await stub.snapshot());
    if (!next.pending.length) {
      expect(next.entries.at(-1).model[0].content).toEqual(
        expect.arrayContaining([{ type: 'text', text: 'Comparison complete.' }]),
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('The next request did not settle');
});
