import { extensionConfiguration } from '../../src/extensions/configuration';
import { defineTask } from '@earendil-works/pi-durable';
import { validateExtensions } from '../../src/server/extensions/registry';
import { BG } from '../../src/server/chat/context';
import { abortAllDurableObjects } from 'cloudflare:test';
import { env, runInDurableObject } from './env';
import { expect, it, vi } from 'vitest';
import { definitions } from '../../src/extensions/server';

it('retries transient extension initialization in the same durable object', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  // Start Lifecycle before injecting a failure; a startup exception closes the
  // input gate rather than reaching the in-object regression assertion below.
  await stub.snapshot();
  await runInDurableObject(stub, async (instance) => {
    const definition = definitions.find((item) => item.id === 'skills')!;
    const factory = vi
      .spyOn(definition, 'create')
      .mockRejectedValueOnce(new Error('temporary source failure'));
    try {
      (instance as any).contributionSet = undefined;
      await expect((instance as any).contributions()).rejects.toThrow('temporary source failure');
      await expect((instance as any).contributions()).resolves.toBeDefined();
      await (instance as any).contributions();
      expect(factory).toHaveBeenCalledTimes(2);
    } finally {
      factory.mockRestore();
    }
  });
});

it('an async native extension runs through Pi history after UI repair exhaustion', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  await stub.submitRun({ runId: crypto.randomUUID(), text: 'invalid_program' });
  for (let i = 0; i < 200; i++) {
    const s = JSON.parse(await stub.snapshot());
    if (!s.pending.length) {
      const results = s.entries
        .flatMap((e: any) => e.model ?? [])
        .filter((m: any) => m.role === 'toolResult');
      expect(results.filter((r: any) => r.toolName === 'prepare_program')).toHaveLength(3);
      expect(results.find((r: any) => r.toolName === 'describe_text')).toMatchObject({
        isError: false,
      });
      return;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Extension did not settle');
});

it('missing native task definitions settle with an explicit recovery diagnostic', async () => {
  let stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const taskId = await runInDurableObject(stub, async (instance) => {
    const root = await instance.root();
    const removed = defineTask({
      name: 'removed.example',
      version: 1,
      initial: () => ({ phase: 'work' as const }),
      phases: { work: async () => {} },
      abort: async () => {},
    });
    return Number(
      await root.commit(
        (tx) => tx.createTask(removed, {}, { ownership: { kind: 'conversation' } }),
        BG,
      ),
    );
  });
  await abortAllDurableObjects();
  stub = env.CONVERSATIONS.get(stub.id);
  for (let i = 0; i < 100; i++) {
    const snapshot = JSON.parse(await stub.snapshot());
    if (snapshot.runtimeIssues.length) {
      expect(snapshot.runtimeIssues).toContainEqual({
        taskId,
        code: 'task_definition_unavailable',
      });
      return;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Missing definition remained live');
});

it('optional UI can be disabled without removing local tools or base rules', async () => {
  const { applicationContributions } = await import('../../src/server/extensions/assembly');
  const contributions = await applicationContributions({} as Env, async () => [], undefined, {
    ...extensionConfiguration,
    openui: { enabled: false },
  });
  const extensions = contributions.flatMap((item) => (item.extension ? [item.extension] : []));
  validateExtensions(extensions);
  expect(extensions.flatMap((e) => e.tools ?? []).map((t) => t.name)).toContain('read_web');
  expect(extensions.flatMap((e) => e.tools ?? []).map((t) => t.name)).not.toContain(
    'describe_text',
  );
  expect(extensions.flatMap((e) => e.tools ?? []).map((t) => t.name)).not.toContain(
    'present_openui',
  );
  expect(extensions.flatMap((e) => e.sections ?? []).map((s) => s.key)).not.toContain(
    'execution-contract',
  );
});

it('the central configuration disables OpenUI and MCP without opening a configured remote connection', async () => {
  const network = vi.spyOn(globalThis, 'fetch');
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  try {
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec('CREATE TABLE test_extensions (id TEXT PRIMARY KEY, enabled INTEGER)');
      state.storage.sql.exec("INSERT INTO test_extensions VALUES('openui',0),('mcp',0)");
      state.storage.sql.exec('CREATE TABLE test_mcp (key TEXT)');
      state.storage.sql.exec("INSERT INTO test_mcp VALUES('unsafe-probe')");
      await instance.root();
      const installed = await (instance as any).extensions();
      const tools = installed
        .flatMap((item: any) => item.tools ?? [])
        .map((tool: any) => tool.name);
      expect(tools).toContain('read_web');
      expect(tools).not.toContain('present_openui');
      expect(tools.some((name: string) => name.startsWith('mcp_'))).toBe(false);
    });
    expect(
      network.mock.calls.some(([input]) =>
        String(input instanceof Request ? input.url : input).includes('mcp.example.test'),
      ),
    ).toBe(false);
  } finally {
    await abortAllDurableObjects();
    network.mockRestore();
  }
});
