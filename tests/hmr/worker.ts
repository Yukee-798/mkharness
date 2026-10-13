import { ConversationAgent as Base, BG } from '../../src/server/conversation';
import type { Harness } from '@earendil-works/pi-durable';
import { fixtureModels } from '../fixture-model';
import { revision } from './revision';

// Test-only observations survive module replacement, but not a Worker restart.
const state = globalThis as typeof globalThis & {
  piHmrProbe?: { runtime: Harness; closed: boolean; id: string }[];
};
state.piHmrProbe ??= [];

export class ConversationAgent extends Base {
  protected override async credentials() {
    return {
      select: async () => ({ source: 'server' as const, fingerprint: 'fixture-only' }),
      resolve: async () => ({ apiKey: 'fixture' }),
    };
  }

  protected override models() {
    return fixtureModels();
  }
  async probe() {
    const runtime = await this.harness.pi();
    if (!state.piHmrProbe!.some((item) => item.runtime === runtime)) {
      const item = { runtime, closed: false, id: crypto.randomUUID() };
      state.piHmrProbe!.push(item);
      const close = runtime.close.bind(runtime);
      runtime.close = async (context) => {
        await close(context);
        item.closed = true;
      };
    }
    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO app_meta(key,value) VALUES(?,?)',
      'hmr-test-marker',
      crypto.randomUUID(),
    );
    const marker = this.ctx.storage.sql
      .exec('SELECT value FROM app_meta WHERE key=?', 'hmr-test-marker')
      .one().value;
    return Promise.all(
      state.piHmrProbe!.map(async (item) => {
        await item.runtime.inspect(BG);
        return { closed: item.closed, id: item.id, marker, revision };
      }),
    );
  }
}

export default {
  async fetch(_request, env) {
    const target = env.CONVERSATIONS.getByName('hmr-probe') as DurableObjectStub<ConversationAgent>;
    return Response.json(await target.probe());
  },
} satisfies ExportedHandler<Env>;
