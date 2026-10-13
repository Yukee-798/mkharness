import { it, expect } from 'vitest';
import { fixtureModels } from '../fixture-model';
import {
  bindExecution,
  executionModels,
  restoreExecutionModels,
} from '../../src/server/execution-models';
import {
  Harness,
  MemoryStorage,
  CompactionTask,
  createRegistry,
  createSession,
} from '@earendil-works/pi-durable';
import { withRunLimits } from '../../src/server/limits';
import { AppError } from '../../src/shared/contracts';
const execution = {
  provider: 'fixture',
  modelId: 'fixture',
  thinkingLevel: 'low' as const,
  credentialRef: { source: 'user' as const, id: crypto.randomUUID() },
};
it('restores a background compaction binding without resolving unrelated completed credentials', async () => {
  const context = { abortSignal: undefined, value: () => undefined, toString: () => '[test]' };
  const credentials = async () => ({
    select: async () => execution.credentialRef,
    resolve: async () => 'original-key',
  });
  const old = {
    ...execution,
    modelId: 'removed',
    credentialRef: { source: 'user' as const, id: crypto.randomUUID() },
  };
  const original = executionModels(fixtureModels());
  const alias = await bindExecution(original, execution, credentials);
  const storage = new MemoryStorage();
  const pi = await Harness.open(storage, { models: original, registry: createRegistry() }, context);
  const root = await pi.root(context, {
    agent: { model: { provider: 'fixture', modelId: 'fixture' } },
  });
  await root.commit(
    (tx) =>
      tx.createTask(
        CompactionTask,
        {
          reason: 'manual',
          execution: { model: { provider: alias, modelId: 'fixture' }, thinkingLevel: 'low' },
        },
        { background: true, ownership: { kind: 'conversation' } },
      ),
    context,
  );
  const rebuilt = executionModels(fixtureModels());
  const records = [old, execution].map((execution) => ({
    accepted: 1,
    stored: { request: { runId: crypto.randomUUID(), text: 'already answered' }, execution },
  }));
  // Ablation: no binding restoration leaves the native compaction model unavailable.
  expect(rebuilt.getModel(alias, 'fixture')).toBeUndefined();
  await restoreExecutionModels(createSession(storage), rebuilt, records, credentials, context);
  expect(rebuilt.getModel(alias, 'fixture')).toBeDefined();
  expect(await rebuilt.getAuth(alias)).toMatchObject({ auth: { apiKey: 'original-key' } });
  await pi.close(context);
});
it('refuses an unaccepted removed model rather than inheriting a newer model', async () => {
  const context = { abortSignal: undefined, value: () => undefined, toString: () => '[test]' };
  await expect(
    restoreExecutionModels(
      createSession(new MemoryStorage()),
      executionModels(fixtureModels()),
      [
        {
          accepted: 0,
          stored: {
            request: { runId: crypto.randomUUID(), text: 'not accepted' },
            execution: { ...execution, modelId: 'removed' },
          },
        },
      ],
      async () => ({ select: async () => execution.credentialRef, resolve: async () => 'key' }),
      context,
    ),
  ).rejects.toMatchObject({ code: 'execution_model_unavailable' });
});
it('validates a second model even when its credential alias is already installed', async () => {
  const models = executionModels(fixtureModels());
  const credentials = async () => ({
    select: async () => execution.credentialRef,
    resolve: async () => 'key',
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
it('normalizes budget refusals before commit rather than leaking a bound provider alias', async () => {
  const models = executionModels(fixtureModels());
  const id = await bindExecution(models, execution, async () => ({
    select: async () => execution.credentialRef,
    resolve: async () => 'key',
  }));
  const limited = withRunLimits(
    models,
    async () =>
      [{ kind: 'pi.user' }, ...Array.from({ length: 20 }, () => ({ kind: 'pi.assistant' }))] as any,
  );
  const result = await limited.completeSimple(models.getModel(id, 'fixture')!, { messages: [] });
  expect(result.errorMessage).toContain('Model round limit');
  expect(result.provider).toBe('fixture');
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
    resolve: async () => 'CANARY-KEY',
  }));
  const result = await models.completeSimple(models.getModel(id, 'fixture')!, { messages: [] });
  expect(result.stopReason).toBe('error');
  expect(JSON.stringify(result)).not.toContain('CANARY-KEY');
});
