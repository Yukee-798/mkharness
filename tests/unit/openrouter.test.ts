import { expect, it } from 'vitest';
import { applicationModels } from '../../src/server/models/catalog';
import { bindExecution, executionModels } from '../../src/server/models/execution';
async function bound() {
  const models = executionModels(
    applicationModels({ MODEL_PROVIDER: 'openrouter', MODEL_ID: 'openrouter/free' }),
  );
  const ref = { source: 'server' as const, fingerprint: 'test' };
  const alias = await bindExecution(
    models,
    {
      provider: 'openrouter',
      modelId: 'openrouter/free',
      thinkingLevel: 'off',
      credentialRef: ref,
    },
    async () => ({ select: async () => ref, resolve: async () => ({ apiKey: 'CANARY-KEY' }) }),
  );
  return { models, model: models.getModel(alias, 'openrouter/free')! };
}
const context = { messages: [{ role: 'user' as const, content: 'hello', timestamp: Date.now() }] };
function sse(chunks: unknown[]) {
  return new Response(
    chunks.map((chunk) => 'data: ' + JSON.stringify(chunk) + '\n\n').join('') + 'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}
it('uses the native OpenRouter SSE and tool-call protocol with only the requested free model', async () => {
  const { models, model } = await bound();
  let calls = 0;
  const stream = models.streamSimple(model, context, {
    fetch: async (_url, init) => {
      calls++;
      expect(JSON.parse(String(init?.body)).model).toBe('openrouter/free');
      return sse([
        { id: 'a', choices: [{ index: 0, delta: { content: 'hello' } }] },
        {
          id: 'a',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'tool-1',
                    type: 'function',
                    function: { name: 'describe_text', arguments: '{"text":"hello"}' },
                  },
                ],
              },
            },
          ],
        },
        { id: 'a', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      ]);
    },
  });
  const events = [];
  for await (const event of stream) events.push(event.type);
  const result = await stream.result();
  expect(events).toContain('text_delta');
  expect(result.stopReason).toBe('toolUse');
  expect(result.content).toContainEqual(
    expect.objectContaining({
      type: 'toolCall',
      name: 'describe_text',
      arguments: { text: 'hello' },
    }),
  );
  expect(calls).toBe(1);
});
it.each([402, 429])(
  'reports free service HTTP %s without retries, credentials or paid fallback',
  async (status) => {
    const { models, model } = await bound();
    let calls = 0;
    const result = await models.completeSimple(model, context, {
      fetch: async (_url, init) => {
        calls++;
        expect(JSON.parse(String(init?.body)).model).toBe('openrouter/free');
        return new Response(
          JSON.stringify({ error: { message: 'CANARY-KEY exhausted', code: status } }),
          { status, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });
    expect(calls).toBe(1);
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toContain('免费模型额度');
    expect(result.errorMessage).toContain('不会自动切换至付费模型');
    expect(JSON.stringify(result)).not.toContain('CANARY-KEY');
  },
);
it('ends an HTTP 200 stream error as a terminal failure rather than successful partial text', async () => {
  const { models, model } = await bound();
  let observed = 0;
  const result = await models.completeSimple(model, context, {
    onProviderStreamEvent: () => {
      observed++;
    },
    fetch: async () =>
      sse([
        { id: 'a', choices: [{ index: 0, delta: { content: 'partial' } }] },
        {
          id: 'a',
          error: { code: 429, message: 'Rate limit exceeded CANARY-KEY' },
          choices: [{ index: 0, delta: {}, finish_reason: 'error' }],
        },
      ]),
  });
  expect(observed).toBe(1);
  expect(result.stopReason).toBe('error');
  expect(result.content).toEqual([]);
  expect(result.errorMessage).toContain('免费模型额度');
});
