import { extensionEnabled, type ExtensionConfiguration } from '../../src/extensions/configuration';
import { asyncExampleContribution } from '../../src/extensions/async-example/server';
import type { RemoteConfig } from '../../src/extensions/async-example/runtime';
import { ConversationAgent as Base } from '../../src/server/conversation';
import { exampleExtension } from '../../src/server/extensions';
import { staticSkills, exampleSkillSource } from '../../src/server/skills';
import { fixtureModels } from '../fixture-model';
import { Type } from '@earendil-works/pi-ai';
import {
  defineTool,
  hook,
  ToolTask,
  type Extension,
  type ToolRegistration,
  type ToolExecutionApi,
} from '@earendil-works/pi-durable';
const progressProbe = defineTool({
  name: 'progress_probe',
  description: 'Test-only native progress seam',
  parameters: Type.Object({ round: Type.Number() }),
  replay: 'safe',
  outputLimits: { maxBytes: 8, retain: 'tail' },
  execute: async ({ round }, api, context) => {
    api.output('abc');
    await api.details({ round, phase: 'first', private: 'never public' }, context);
    await new Promise((resolve) => setTimeout(resolve, 200));
    api.output('def');
    await new Promise((resolve) => setTimeout(resolve, 200));
    api.output('ghijkl');
    await api.details({ round, phase: 'last' }, context);
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { output: [{ type: 'text', text: `round ${round}` }] };
  },
});
export class ConversationAgent extends Base {
  protected override async credentials() {
    return {
      select: async () => ({ source: 'server' as const, fingerprint: 'fixture-only' }),
      resolve: async () => ({ apiKey: 'fixture' }),
    };
  }
  private asyncConfiguration(): RemoteConfig | undefined {
    const sql = this.ctx.storage.sql;
    if (sql.exec("SELECT name FROM sqlite_master WHERE name='test_remote'").toArray().length)
      return {
        endpoint: String(
          sql.exec('SELECT * FROM test_remote').toArray()[0].endpoint ??
            'https://async.example.test',
        ),
        recovery: sql.exec('SELECT mode FROM test_remote').toArray()[0].mode as
          'key' | 'none' | 'lookup',
        waitMs: Number(sql.exec('SELECT * FROM test_remote').toArray()[0].wait_ms ?? 5000),
        pollMs: [100, 200, 500],
      };
    return undefined;
  }
  protected override mcpConfiguration() {
    const sql = this.ctx.storage.sql;
    if (sql.exec("SELECT name FROM sqlite_master WHERE name='test_mcp'").toArray().length)
      return [
        {
          serverId: 'reference',
          endpoint: 'https://mcp.example.test/mcp?conversation=' + this.ctx.id.toString(),
          credential: sql.exec("SELECT key FROM test_mcp WHERE key='credential-probe'").toArray()
            .length
            ? 'MCP_FIXTURE_TOKEN'
            : undefined,
          allowlist: sql.exec("SELECT key FROM test_mcp WHERE key='unsafe-probe'").toArray().length
            ? ['lookup', 'status']
            : ['lookup'],
          safeTools: sql.exec("SELECT key FROM test_mcp WHERE key='unsafe-probe'").toArray().length
            ? ['status']
            : [],
        },
      ];
    return super.mcpConfiguration();
  }
  protected override models() {
    return fixtureModels();
  }
  protected override extensionConfiguration(): ExtensionConfiguration {
    const config = { ...super.extensionConfiguration() };
    const sql = this.ctx.storage.sql;
    if (sql.exec("SELECT name FROM sqlite_master WHERE name='test_extensions'").toArray().length)
      for (const row of sql.exec('SELECT id,enabled FROM test_extensions').toArray())
        config[String(row.id)] = { ...config[String(row.id)], enabled: row.enabled === 1 };
    return config;
  }
  protected override async contributions() {
    return [
      ...(await super.contributions()).filter((item) => item.id !== 'async-example'),
      ...(extensionEnabled('async-example', this.extensionConfiguration())
        ? [asyncExampleContribution(this.asyncConfiguration(), this.contributionHost())]
        : []),
      {
        id: 'progress-fixture',
        extension: {
          name: 'progress-fixture',
          tools: [
            progressProbe,
            defineTool({
              name: 'fault_probe',
              description: 'Test-only native fault',
              parameters: Type.Object({}),
              replay: 'safe',
              execute: async () => null as never,
            }),
          ],
        },
        projectTool: ({ output, details }: any) => ({
          output: output ?? '',
          phase: details?.phase ?? null,
        }),
      },
    ];
  }
  protected override async extensions() {
    const extensions: Extension[] = [
      ...(await super.extensions()),
      exampleExtension(),
      await staticSkills([exampleSkillSource()]),
      {
        name: 'fixture',
        sections: [
          {
            key: 'model-binding-probe',
            render: (input: import('@earendil-works/pi-durable').PromptInput) => {
              const sql = this.ctx.storage.sql;
              if (
                sql.exec("SELECT name FROM sqlite_master WHERE name='test_model_prepare'").toArray()
                  .length
              ) {
                sql.exec(
                  'INSERT INTO test_model_prepare(model,thinking)VALUES(?,?)',
                  input.agent.model?.modelId ?? '',
                  input.agent.thinkingLevel,
                );
              }
              return undefined;
            },
          },
        ],
        wraps: extensionEnabled('openui', this.extensionConfiguration())
          ? [
              {
                tool: 'present_openui',
                wrap: (tool: ToolRegistration) => ({
                  ...tool,
                  execute: async (
                    args: any,
                    api: ToolExecutionApi,
                    context: Parameters<ToolRegistration['execute']>[2],
                  ) => {
                    const result = await tool.execute(args, api, context);
                    const sql = this.ctx.storage.sql;
                    const armed =
                      sql.exec("SELECT name FROM sqlite_master WHERE name='test_fault'").toArray()
                        .length &&
                      sql.exec("SELECT value FROM test_fault WHERE key='armed'").toArray()[0]
                        ?.value;
                    if (armed) {
                      sql.exec(
                        "INSERT INTO test_fault VALUES('reached',1) ON CONFLICT(key) DO NOTHING",
                      );
                      await new Promise((r) => setTimeout(r, 500));
                      sql.exec("UPDATE test_fault SET value=0 WHERE key='armed'");
                    }
                    return result;
                  },
                }),
              },
            ]
          : [],
        tools: [
          defineTool({
            name: 'ignores_cancel',
            description: 'Test-only uncancellable bounded tool',
            parameters: Type.Object({}),
            replay: 'safe',
            execute: async () => {
              await new Promise((r) => setTimeout(r, 800));
              return { output: [{ type: 'text' as const, text: 'completed' }] };
            },
          }),
        ],
      },
    ];
    const sql = this.ctx.storage.sql;
    if (
      sql.exec("SELECT name FROM sqlite_master WHERE name='test_mcp'").toArray().length &&
      sql.exec("SELECT key FROM test_mcp WHERE key='pause-result'").toArray().length
    )
      extensions.push({
        name: 'mcp-receipt-gate',
        hooks: [
          hook(ToolTask, {
            afterTool: async (call, _result, _api, context) => {
              if (call.name !== 'mcp_reference_lookup' || _result.isError) return;
              sql.exec("INSERT INTO test_mcp VALUES('result-paused')");
              await new Promise<never>((_resolve, reject) => {
                const abort = () => reject(context.abortSignal?.reason);
                if (context.abortSignal?.aborted) abort();
                else context.abortSignal?.addEventListener('abort', abort, { once: true });
              });
            },
          }),
        ],
      });
    // Deliberately broken host for a negative control; never part of the production entry.
    if (
      this.ctx.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE name='test_guardless'")
        .toArray().length
    )
      return extensions.map((extension) =>
        extension.name === 'remote-example'
          ? {
              ...extension,
              hooks: [],
              tools: extension.tools!.map((tool) =>
                tool.name === 'example_generate'
                  ? {
                      ...tool,
                      replay: 'unsafe' as const,
                      execute: async (args: Record<string, unknown>) => {
                        await fetch('https://async.example.test/requests', {
                          method: 'POST',
                          body: JSON.stringify(args),
                        });
                        return {
                          output: [{ type: 'text' as const, text: 'guardless negative control' }],
                        };
                      },
                    }
                  : tool,
              ),
            }
          : extension,
      );
    return extensions;
  }
}
export default { fetch: () => new Response('test fixture') };
