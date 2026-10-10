import { env } from 'cloudflare:test';
import { it, expect } from 'vitest';
import { applicationModels, applicationThinkingLevel } from '../../src/server/models';
it('enables low reasoning by default and respects an explicit off setting', async () => {
  expect(applicationThinkingLevel({})).toBe('low');
  expect(applicationThinkingLevel({ MODEL_THINKING_LEVEL: 'off' })).toBe('off');
  expect(() => applicationThinkingLevel({ MODEL_THINKING_LEVEL: 'invalid' })).toThrow(
    'Invalid MODEL_THINKING_LEVEL',
  );
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  await stub.submitRun({ runId: crypto.randomUUID(), text: 'configuration check' });
  // The chosen level belongs to the Pi agent, not a duplicate application settings table.
  const { runInDurableObject } = await import('cloudflare:test');
  const { BG } = await import('../../src/server/conversation');
  expect(
    await runInDurableObject(
      stub,
      async (instance) => (await (await instance.root()).agent(BG)).thinkingLevel,
    ),
  ).toBe('low');
});
it('registers the installed DeepSeek provider with an explicit catalog model', async () => {
  const models = applicationModels({
    ...env,
    MODEL_PROVIDER: 'deepseek',
    MODEL_ID: 'deepseek-flash',
    MODEL_API_KEY: 'fixture-only',
  });
  expect(models.getModel('deepseek', 'deepseek-flash')).toMatchObject({
    provider: 'deepseek',
    id: 'deepseek-flash',
    baseUrl: 'https://api.deepseek.com',
    api: 'openai-completions',
  });
  expect(await models.getAuth('deepseek')).toMatchObject({
    auth: { apiKey: 'fixture-only' },
    source: 'application',
  });
});
it('rejects an absent model instead of silently substituting another DeepSeek model', () => {
  expect(() =>
    applicationModels({
      ...env,
      MODEL_PROVIDER: 'deepseek',
      MODEL_ID: 'missing-model',
      MODEL_API_KEY: 'fixture-only',
    }),
  ).toThrow('MODEL_ID is absent');
});
