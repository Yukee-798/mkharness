import { afterEach, expect, it, vi } from 'vitest';
import { applicationModels, modelProviders } from '../../src/server/models';
import { executionModels, bindExecution } from '../../src/server/execution-models';

afterEach(() => vi.restoreAllMocks());
it.each(modelProviders)(
  'delivers $id native requests to the accepted endpoint with the bound Key',
  async (definition) => {
    const requests: { url: string; headers: Headers; body: string }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
      if (new URL(url).origin === 'https://cloudflare-dns.com')
        return Response.json({ Answer: [{ type: 1, data: '93.184.216.34' }] });
      requests.push({ url, headers: new Headers(init?.headers), body: String(init?.body) });
      return Response.json({ error: { message: 'controlled endpoint failure' } }, { status: 400 });
    });
    const models = executionModels(applicationModels({}));
    const credentialRef = { source: 'user' as const, id: crypto.randomUUID() };
    const alias = await bindExecution(
      models,
      {
        provider: definition.id,
        modelId: definition.defaultModel,
        thinkingLevel: 'low',
        credentialRef,
      },
      async () => ({
        select: async () => credentialRef,
        resolve: async () => ({
          apiKey: 'WIRE-CANARY-KEY',
          baseUrl: 'https://custom.example.com/api',
        }),
      }),
    );
    const model = models.getModel(alias, definition.defaultModel)!;
    const result = await models.completeSimple(model, {
      messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }],
    });
    expect(result.stopReason).toBe('error');
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(
      'https://custom.example.com/api' +
        (definition.id === 'openai'
          ? '/responses'
          : definition.id === 'anthropic'
            ? '/v1/messages?beta=true'
            : '/chat/completions'),
    );
    expect(
      requests[0].headers.get(definition.id === 'anthropic' ? 'x-api-key' : 'authorization'),
    ).toBe(definition.id === 'anthropic' ? 'WIRE-CANARY-KEY' : 'Bearer WIRE-CANARY-KEY');
    expect(JSON.parse(requests[0].body).model).toBe(definition.defaultModel);
    expect(JSON.stringify(result)).not.toContain('WIRE-CANARY');
  },
);
