import { exampleExtension } from '../../src/extensions/example/server';
import { ChatFixture as ChatSession } from './chat-fixture';
import { ModelCredentials } from '../../src/server/models/credentials';
import { applicationModels } from '../../src/server/models/catalog';
import type { Models } from '@earendil-works/pi-ai/models';

/** Test-only native protocol fixture; all task, tool, resource and SSE behavior remains production code. */
export class OpenRouterProbe extends ChatSession {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, {
      ...env,
      MODEL_PROVIDER: 'openrouter',
      MODEL_ID: 'openrouter/free',
      MODEL_THINKING_LEVEL: 'off',
      ALLOW_SERVER_MODEL_KEY: '1',
      MODEL_API_KEY: 'free-canary',
    });
  }
  protected override async credentials() {
    return new ModelCredentials(this.env, (await this.actor()).ownerId);
  }
  protected override async extensions() {
    return [...(await super.extensions()), exampleExtension()];
  }
  protected override models(): Models {
    const models = applicationModels(
      this.env,
    ) as import('@earendil-works/pi-ai/models').MutableModels;
    const provider = models.getProvider('openrouter')!;
    const fixture: typeof fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS test_openrouter_requests(model TEXT)');
      this.ctx.storage.sql.exec(
        'INSERT INTO test_openrouter_requests(model)VALUES(?)',
        request.model,
      );
      if (
        request.messages.some(
          (m: { role: string; content: unknown }) =>
            m.role === 'user' && String(m.content).includes('quota fixture'),
        )
      )
        return new Response(
          JSON.stringify({ error: { code: 429, message: 'Rate limit exceeded' } }),
          { status: 429, headers: { 'Content-Type': 'application/json' } },
        );
      const toolResults = request.messages.filter((m: { role: string }) => m.role === 'tool');
      const delta =
        toolResults.length === 0
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: 'local-count',
                  type: 'function',
                  function: {
                    name: 'describe_text',
                    arguments: JSON.stringify({ text: '你好世界' }),
                  },
                },
              ],
            }
          : {
              tool_calls: [
                {
                  index: 0,
                  id: 'publish',
                  type: 'function',
                  function: {
                    name: 'present_openui',
                    arguments: JSON.stringify({
                      ui: 'root = Stack([TextContent("## 验证结果\\n共 4 个字符")])',
                    }),
                  },
                },
              ],
            };
      const chunks = [
        { id: 'native', choices: [{ index: 0, delta }] },
        { id: 'native', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      ];
      return new Response(
        chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    };
    models.setProvider({
      ...provider,
      streamSimple: (model, context, options) =>
        provider.streamSimple(model, context, { ...options, fetch: fixture }),
    });
    return models;
  }
}
