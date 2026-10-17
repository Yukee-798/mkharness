import { DurableObject } from 'cloudflare:workers';
import { ChatRuntime } from '../../src/server/chat/runtime';
import { BG } from '../../src/server/chat/context';
import type { Harness } from '@earendil-works/pi-durable';
import { fixtureModels } from '../fixture-model';
import { revision } from './revision';
type HmrEnv = { CONVERSATIONS: DurableObjectNamespace<ChatSession> };
const state = globalThis as typeof globalThis & {
  piHmrProbe?: { runtime: Harness; closed: boolean; id: string }[];
};
state.piHmrProbe ??= [];
export class ChatSession extends DurableObject<HmrEnv> {
  private runtime = new ChatRuntime(this.ctx);
  async probe() {
    const pi = await this.runtime.open({
      models: fixtureModels(),
      extensions: [],
      restore: async () => {},
      committed: () => {},
    });
    if (!state.piHmrProbe!.some((item) => item.runtime === pi)) {
      const item = { runtime: pi, closed: false, id: crypto.randomUUID() };
      state.piHmrProbe!.push(item);
      pi.subscribeClose(() => {
        item.closed = true;
      });
    }
    const root = await pi.root(BG);
    await root.commit(async () => {}, BG);
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS hmr_probe(marker TEXT PRIMARY KEY)');
    if (!this.ctx.storage.sql.exec('SELECT marker FROM hmr_probe').toArray().length)
      this.ctx.storage.sql.exec('INSERT INTO hmr_probe VALUES(?)', crypto.randomUUID());
    const marker = this.ctx.storage.sql.exec('SELECT marker FROM hmr_probe').one().marker;
    return state.piHmrProbe!.map((item) => ({
      closed: item.closed,
      id: item.id,
      marker,
      revision,
    }));
  }
}
export default {
  async fetch(_request, env) {
    return Response.json(await env.CONVERSATIONS.getByName('hmr-probe').probe());
  },
} satisfies ExportedHandler<HmrEnv>;
