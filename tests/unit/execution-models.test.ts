import { it, expect, vi } from 'vitest';
import { fixtureModels } from '../fixture-model';
import {
  bindExecution,
  executionModels,
  restoreExecutionModels,
  executionProviderId,
} from '../../src/server/models/execution';
import {
  Harness,
  MemoryStorage,
  CompactionTask,
  createRegistry,
  defineTask,
  UserEntry,
} from '@earendil-works/pi-durable';
import { AppError } from '../../src/shared/contracts';
const execution = {
  provider: 'fixture',
  modelId: 'fixture',
  thinkingLevel: 'low' as const,
  credentialRef: { source: 'user' as const, id: crypto.randomUUID() },
};
const context = { abortSignal: undefined, value: () => undefined, toString: () => '[test]' };
const credentials = async () => ({
  select: async () => execution.credentialRef,
  resolve: async () => ({ apiKey: 'original-key' }),
});
class ReopenableMemoryStorage extends MemoryStorage {
  override async close() {}
}

it('restores every branch and task-owned child plus a pinned compaction, without resolving any secret at startup', async () => {
  const records = Array.from({ length: 5 }, (_, index) => ({
    execution: {
      ...execution,
      modelId: index === 3 ? 'fixture-pro' : 'fixture',
      credentialRef: { source: 'user' as const, id: crypto.randomUUID() },
    },
  }));
  const aliases = await Promise.all(records.map(({ execution }) => executionProviderId(execution)));
  const pi = await Harness.open(
    new MemoryStorage(),
    { models: executionModels(fixtureModels()), registry: createRegistry() },
    context,
  );
  try {
    const root = await pi.root(context, {
      agent: { model: { provider: aliases[0], modelId: 'fixture' } },
    });
    const at = await root.commit(
      (tx) =>
        tx.appendEntry(UserEntry, root.id, {
          model: [{ role: 'user', content: 'inherited', timestamp: 1 }],
        }),
      context,
    );
    await root.fork(
      at.id,
      {
        ownership: { kind: 'ownerless' },
        agent: { model: { provider: aliases[1], modelId: 'fixture' } },
      },
      context,
    );
    const parent = await root.commit(
      (tx) =>
        tx.createTask(
          CompactionTask,
          { reason: 'manual' },
          { ownership: { kind: 'conversation' } },
        ),
      context,
    );
    const child = await pi.createConversation(
      {
        ownership: { kind: 'task', taskId: parent },
        agent: { model: { provider: aliases[2], modelId: 'fixture' } },
      },
      context,
    );
    const pinned = defineTask({
      ...CompactionTask.definition,
      initial: () => ({
        phase: 'summarize' as const,
        attempt: 0,
        model: { provider: aliases[3], modelId: 'fixture-pro' },
        thinkingLevel: 'low' as const,
        streamOptions: {},
        maxTokens: 100,
        tail: at.id,
        firstKept: at.id,
      }),
    });
    await child.commit(
      (tx) =>
        tx.createTask(
          pinned,
          { reason: 'manual' },
          { ownership: { kind: 'conversation' }, background: true },
        ),
      context,
    );
    // Cross the native scan page boundary too. These base-model configurations
    // require no credential binding and must not hide a later owned conversation.
    for (let index = 0; index < 101; index++)
      await pi.createConversation(
        {
          ownership: { kind: 'ownerless' },
          agent: { model: { provider: 'fixture', modelId: 'fixture' } },
        },
        context,
      );
    const rebuilt = executionModels(fixtureModels());
    const access = vi.fn(credentials);
    const lookup = vi.fn(
      async (_refs: readonly import('@earendil-works/pi-durable').ModelRef[]) => records,
    );
    await restoreExecutionModels(pi, rebuilt, lookup, access, context);
    expect(lookup.mock.calls[0][0]).toEqual(
      expect.arrayContaining(
        aliases.slice(0, 4).map((provider, index) => ({
          provider,
          modelId: index === 3 ? 'fixture-pro' : 'fixture',
        })),
      ),
    );
    for (let index = 0; index < 4; index++)
      expect(rebuilt.getModel(aliases[index], records[index].execution.modelId)).toBeDefined();
    expect(rebuilt.getProvider(aliases[4])).toBeUndefined(); // Completed unrelated credential.
    expect(access).not.toHaveBeenCalled();
    expect(await rebuilt.getAuth(aliases[2])).toMatchObject({ auth: { apiKey: 'original-key' } });
    expect(access).toHaveBeenCalledOnce();
  } finally {
    await pi.close(context);
  }
});
it('includes prepared configuration in AgentDoc while a removed model remains unavailable without blocking history', async () => {
  const removed = { ...execution, modelId: 'removed' };
  const alias = await executionProviderId(removed);
  const pi = await Harness.open(
    new MemoryStorage(),
    { models: executionModels(fixtureModels()), registry: createRegistry() },
    context,
  );
  try {
    await pi.root(context, { agent: { model: { provider: alias, modelId: removed.modelId } } });
    const lookup = vi.fn(
      async (_refs: readonly import('@earendil-works/pi-durable').ModelRef[]) => [
        { execution: removed },
      ],
    );
    const rebuilt = executionModels(fixtureModels());
    await expect(
      restoreExecutionModels(pi, rebuilt, lookup, credentials, context),
    ).resolves.toBeUndefined();
    expect(lookup.mock.calls[0][0]).toContainEqual({ provider: alias, modelId: removed.modelId });
    expect(rebuilt.getModel(alias, removed.modelId)).toBeUndefined();
  } finally {
    await pi.close(context);
  }
});
it('lets native pending work fail on a missing binding without preventing conversation recovery', async () => {
  const storage = new ReopenableMemoryStorage();
  const original = executionModels(fixtureModels());
  const alias = await bindExecution(original, execution, credentials);
  const pi = await Harness.open(storage, { models: original, registry: createRegistry() }, context);
  const root = await pi.root(context, {
    agent: { model: { provider: alias, modelId: 'fixture' } },
  });
  const taskId = await root.commit(
    (tx) =>
      tx.createTask(CompactionTask, { reason: 'manual' }, { ownership: { kind: 'conversation' } }),
    context,
  );
  await pi.close(context);
  const rebuilt = executionModels(fixtureModels());
  const restored = await Harness.open(
    storage,
    { models: rebuilt, registry: createRegistry() },
    context,
  );
  try {
    await expect(
      restoreExecutionModels(restored, rebuilt, async () => [], credentials, context),
    ).resolves.toBeUndefined();
    expect(rebuilt.getModel(alias, 'fixture')).toBeUndefined();
    restored.resume();
    await expect
      .poll(async () => (await restored.getTask(taskId, context))?.state)
      .toMatchObject({ status: 'terminal', outcome: { status: 'failed' } });
    expect(await restored.conversation(root.id, context)).toBeDefined();
  } finally {
    await restored.close(context);
  }
});
it('validates a second model even when its credential alias is already installed', async () => {
  const models = executionModels(fixtureModels());
  const credentials = async () => ({
    select: async () => execution.credentialRef,
    resolve: async () => ({ apiKey: 'key' }),
  });
  await bindExecution(models, execution, credentials);
  await expect(
    bindExecution(models, { ...execution, modelId: 'removed' }, credentials),
  ).rejects.toMatchObject({ code: 'execution_model_unavailable' });
});
it('keeps trusted credential failure reasons and hides internal provider identity', async () => {
  const models = executionModels(fixtureModels());
  const id = await bindExecution(models, execution, async () => ({
    select: async () => execution.credentialRef,
    resolve: async () => {
      throw new AppError(
        503,
        'credential_unavailable',
        '原请求的个人凭据已撤销或过期，请发起新请求',
      );
    },
  }));
  const result = await models.completeSimple(models.getModel(id, 'fixture')!, { messages: [] });
  expect(result.errorMessage).toBe('原请求的个人凭据已撤销或过期，请发起新请求');
  expect(result.provider).toBe('fixture');
  expect(JSON.stringify(result)).not.toContain('mkharness-bound');
});
it('does not persist supplier error bodies that echo the key', async () => {
  const base = fixtureModels(),
    provider = base.getProvider('fixture')!;
  base.setProvider({
    ...provider,
    streamSimple: () => {
      throw new Error('echo CANARY-KEY');
    },
  });
  const models = executionModels(base);
  const id = await bindExecution(models, execution, async () => ({
    select: async () => execution.credentialRef,
    resolve: async () => ({ apiKey: 'CANARY-KEY' }),
  }));
  const result = await models.completeSimple(models.getModel(id, 'fixture')!, { messages: [] });
  expect(result.stopReason).toBe('error');
  expect(JSON.stringify(result)).not.toContain('CANARY-KEY');
});

it('uses native auth Base URL overrides without changing model identity, protocol or context window', async () => {
  const base = fixtureModels(),
    provider = base.getProvider('fixture')!,
    seen: any[] = [];
  base.setProvider({
    ...provider,
    streamSimple: (model, context, options) => {
      seen.push({ model, apiKey: options?.apiKey });
      return provider.streamSimple(model, context, options);
    },
  });
  const models = executionModels(base),
    original = base.getModel('fixture', 'fixture')!;
  const alias = await bindExecution(models, execution, async () => ({
    select: async () => execution.credentialRef,
    resolve: async () => ({ apiKey: 'frozen-key', baseUrl: 'https://custom.example.com/v1' }),
  }));
  await models.completeSimple(models.getModel(alias, 'fixture')!, { messages: [] });
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({
    model: {
      id: original.id,
      provider: original.provider,
      api: original.api,
      contextWindow: original.contextWindow,
      baseUrl: 'https://custom.example.com/v1',
    },
    apiKey: 'frozen-key',
  });
  expect(original.baseUrl).not.toBe('https://custom.example.com/v1');
});
