import { ConversationAgent as Fixture } from './entry';
import type { ToolRegistration } from '@earendil-works/pi-durable';

export { ConversationAgent } from './entry';
export { BindingProbe } from './task-binding-entry';

/** Test observations over real DO reconstruction, without replacing lifecycle behavior. */
export class LifecycleProbe extends Fixture {
  readonly instanceId = crypto.randomUUID();
  private opens = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS test_lifecycle_counts(name TEXT PRIMARY KEY,n INTEGER NOT NULL)',
    );
  }

  private count(name: string) {
    this.ctx.storage.sql.exec(
      'INSERT INTO test_lifecycle_counts(name,n)VALUES(?,1) ON CONFLICT(name)DO UPDATE SET n=n+1',
      name,
    );
    return Number(
      this.ctx.storage.sql.exec('SELECT n FROM test_lifecycle_counts WHERE name=?', name).one().n,
    );
  }

  protected override async contributions() {
    const contributions = await super.contributions();
    return contributions.map((contribution) =>
      contribution.id !== 'progress-fixture'
        ? contribution
        : {
            ...contribution,
            extension: {
              ...contribution.extension!,
              tools: contribution.extension!.tools!.map((tool) =>
                tool.name !== 'progress_probe'
                  ? tool
                  : {
                      ...tool,
                      execute: async (...call: Parameters<typeof tool.execute>) => {
                        const [args, api, context] = call;
                        const input = args as { round: number };
                        const { round } = input;
                        const attempt = this.count(`progress:${round}`);
                        if (round === 1 && attempt === 1) {
                          await new Promise<void>((resolve) => {
                            if (context.abortSignal?.aborted) resolve();
                            else
                              context.abortSignal?.addEventListener('abort', () => resolve(), {
                                once: true,
                              });
                          });
                        }
                        return tool.execute(input, api, context);
                      },
                    },
              ),
            },
          },
    );
  }

  protected override async extensions() {
    this.opens++;
    return [
      ...(await super.extensions()),
      {
        name: 'lifecycle-counts',
        wraps: ['activate_skill', 'read_skill_resource'].map((tool) => ({
          tool,
          wrap: (original: ToolRegistration) => ({
            ...original,
            execute: async (...args: Parameters<ToolRegistration['execute']>) => {
              this.count(tool);
              return original.execute(...args);
            },
          }),
        })),
      },
    ];
  }

  probe() {
    return {
      instanceId: this.instanceId,
      opens: this.opens,
      counts: this.ctx.storage.sql
        .exec<{ name: string; n: number }>('SELECT * FROM test_lifecycle_counts ORDER BY name')
        .toArray(),
      requests: this.ctx.storage.sql.exec('SELECT id,accepted FROM app_requests').toArray(),
    };
  }
}

export default { fetch: () => new Response('lifecycle test fixture') };

export { BYOKProbe } from './byok-entry';
