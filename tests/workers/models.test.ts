import { env } from 'cloudflare:test';
import { it, expect } from 'vitest';
import {
  applicationModels,
  applicationThinkingLevel,
  applicationModelCatalog,
  validateModelSelection,
} from '../../src/server/models';
import { runInDurableObject, abortAllDurableObjects } from 'cloudflare:test';
it('enables low reasoning by default and respects an explicit off setting', async () => {
  expect(applicationThinkingLevel({})).toBe('low');
  expect(applicationThinkingLevel({ MODEL_THINKING_LEVEL: 'off' })).toBe('off');
  expect(() => applicationThinkingLevel({ MODEL_THINKING_LEVEL: 'invalid' })).toThrow(
    'Invalid MODEL_THINKING_LEVEL',
  );
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  await stub.submitRun({ runId: crypto.randomUUID(), text: 'configuration check' });
  const snapshot = await settle(stub);
  expect(snapshot.modelCatalog.defaultSelection.thinkingLevel).toBe('low');
  expect(
    snapshot.entries
      .flatMap((entry: any) => entry.model ?? [])
      .find((message: any) => message.role === 'assistant').thinkingLevel,
  ).toBe('low');
});
it('registers the installed DeepSeek provider with an explicit catalog model', async () => {
  const models = applicationModels({
    ...env,
    MODEL_PROVIDER: 'deepseek',
    MODEL_ID: 'deepseek-flash',
  });
  expect(models.getModel('deepseek', 'deepseek-flash')).toMatchObject({
    provider: 'deepseek',
    id: 'deepseek-flash',
    baseUrl: 'https://api.deepseek.com',
    api: 'openai-completions',
  });
  await expect(models.getAuth('deepseek')).rejects.toThrow();
});
it('rejects an absent model instead of silently substituting another DeepSeek model', () => {
  expect(() =>
    applicationModels({
      ...env,
      MODEL_PROVIDER: 'deepseek',
      MODEL_ID: 'missing-model',
    }),
  ).toThrow('MODEL_ID is absent');
});
it('publishes only allowed catalog models and their actual Pi effort levels without credentials', () => {
  const config = {
    MODEL_PROVIDER: 'deepseek',
    MODEL_ID: 'deepseek-flash',
  };
  const models = applicationModels(config);
  const catalog = applicationModelCatalog(config, models);
  expect(catalog.models.filter((m) => m.provider === 'deepseek').map((m) => m.id)).toEqual([
    'deepseek-flash',
    'deepseek-v4-pro',
  ]);
  expect(catalog.models.find((m) => m.id === 'deepseek-flash')!.thinkingLevels).toEqual([
    'off',
    'low',
    'high',
    'max',
  ]);
  expect(catalog.models.find((m) => m.id === 'deepseek-v4-pro')!.thinkingLevels).toEqual([
    'off',
    'high',
    'max',
  ]);
  expect(JSON.stringify(catalog)).not.toContain('fixture-only');
  expect(applicationModelCatalog({ ...config, MODEL_IDS: '' }, models)).toEqual(catalog);
  const restricted = { ...config, MODEL_IDS: 'deepseek-flash' };
  expect(() =>
    validateModelSelection(restricted, models, {
      provider: 'deepseek',
      modelId: 'deepseek-v4-pro',
      thinkingLevel: 'high',
    }),
  ).toThrow('所选模型不可用');
  expect(() =>
    validateModelSelection(config, models, {
      provider: 'deepseek',
      modelId: 'deepseek-v4-pro',
      thinkingLevel: 'low',
    }),
  ).toThrow('该模型不支持');
  expect(() => applicationModelCatalog({ ...config, MODEL_IDS: 'missing' }, models)).toThrow(
    'MODEL_IDS must include',
  );
});
async function settle(stub: ReturnType<typeof env.CONVERSATIONS.getByName>) {
  for (let i = 0; i < 250; i++) {
    const snapshot = JSON.parse(await stub.snapshot());
    if (!snapshot.pending.length) return snapshot;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Model selection queue did not settle');
}
it('keeps per-request model and effort across a busy queue, retries and SQLite-preserving restart', async () => {
  let stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec('CREATE TABLE test_model_prepare(model TEXT,thinking TEXT)');
  });
  const commands = [
    {
      runId: crypto.randomUUID(),
      text: 'slow first',
      config: { provider: 'fixture', modelId: 'fixture', thinkingLevel: 'low' as const },
    },
    {
      runId: crypto.randomUUID(),
      text: 'second',
      config: { provider: 'fixture', modelId: 'fixture-pro', thinkingLevel: 'high' as const },
    },
    {
      runId: crypto.randomUUID(),
      text: 'third',
      config: { provider: 'fixture', modelId: 'fixture', thinkingLevel: 'off' as const },
    },
  ];
  for (const command of commands)
    expect(await stub.submitRun(command)).toMatchObject({ accepted: true });
  expect(await stub.submitRun(commands[1])).toMatchObject({ accepted: true });
  expect(
    await stub.submitRun({
      ...commands[1],
      config: { ...commands[1].config, thinkingLevel: 'max' },
    }),
  ).toMatchObject({ error: { status: 409 } });
  await abortAllDurableObjects();
  stub = env.CONVERSATIONS.get(stub.id);
  const snapshot = await settle(stub);
  const messages = snapshot.entries
    .flatMap((e: any) => e.model ?? [])
    .filter((m: any) => m.role === 'assistant');
  expect(messages.map((m: any) => [m.model, m.thinkingLevel])).toEqual([
    ['fixture', 'low'],
    ['fixture-pro', 'high'],
    ['fixture', 'off'],
  ]);
  expect(
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec('SELECT model,thinking FROM test_model_prepare').toArray(),
    ),
  ).toEqual([
    { model: 'fixture', thinking: 'low' },
    { model: 'fixture-pro', thinking: 'high' },
    { model: 'fixture', thinking: 'off' },
  ]);
  expect(snapshot.selection).toEqual(commands[2].config);
  expect(
    snapshot.entries.flatMap((e: any) => e.model ?? []).filter((m: any) => m.role === 'user'),
  ).toHaveLength(3);
  expect(
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec('SELECT payload FROM app_requests ORDER BY rowid')
        .toArray()
        .map((r) => {
          const payload = JSON.parse(String(r.payload));
          return payload.execution;
        }),
    ),
  ).toEqual(
    commands.map((c) => ({
      ...c.config,
      credentialRef: { source: 'server', fingerprint: 'fixture-only' },
    })),
  );
});
it('rejects unsupported choices before inserting a request', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  for (const config of [
    { provider: 'fixture', modelId: 'missing', thinkingLevel: 'low' as const },
    { provider: 'fixture', modelId: 'fixture-pro', thinkingLevel: 'low' as const },
  ]) {
    expect(
      await stub.submitRun({ runId: crypto.randomUUID(), text: 'invalid', config }),
    ).toMatchObject({ error: { status: 400 } });
  }
  expect(
    await runInDurableObject(
      stub,
      (_instance, state) =>
        state.storage.sql.exec('SELECT COUNT(*) AS count FROM app_requests').one().count,
    ),
  ).toBe(0);
});
