import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { defineTool, LiveDoc, AgentDoc } from '@earendil-works/pi-durable';
import { openDurableObjectSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/cloudflare';
import { Type } from '@earendil-works/pi-ai';
import {
  ConversationPolicy,
  ExecutionScope,
  reserveModel,
  narrowConversationPolicy,
} from '../../src/server/chat/policy';
import {
  policyHarness,
  policyContext as c,
  seedPolicyExecution,
  policyInput,
} from '../policy-fixture';
import type { StorageProbe } from './entry';
const probes = (env as unknown as { STORAGE_PROBES: DurableObjectNamespace<StorageProbe> })
  .STORAGE_PROBES;
it('retains native input scope and prepared generation reservation across official SQLite cold open', async () => {
  await runInDurableObject(probes.get(probes.newUniqueId()), async (_instance, state) => {
    const openStorage = () =>
      openDurableObjectSqliteStorage(state.storage, { prefix: 'pi_policy_' });
    let pi = await policyHarness({ storage: await openStorage() });
    const root = await pi.root(c);
    await seedPolicyExecution(pi, root);
    const before = (await pi.snapshot(ConversationPolicy, String(root.id), c))!;
    await pi.close(c);
    pi = await policyHarness({ storage: await openStorage() });
    try {
      await reserveModel(pi, root.id, { provider: 'fixture', modelId: 'fixture' }, c);
      const recovered = (await pi.snapshot(ExecutionScope, before.scope!, c))!;
      expect(recovered.rounds).toHaveLength(1);
      expect((await pi.snapshot(ConversationPolicy, String(root.id), c))!.scope).toBe(before.scope);
      expect((await pi.snapshot(LiveDoc, root.id, c))!.run!.inputs[0]).toBe(recovered.inputId);
    } finally {
      await pi.close(c);
    }
  });
});
it.each([false, true])(
  'checks the actual safe ToolTask execute boundary after cold open (narrow=%s)',
  async (narrow) => {
    await runInDurableObject(probes.get(probes.newUniqueId()), async (_instance, state) => {
      let calls = 0,
        started!: () => void;
      const called = new Promise<void>((resolve) => {
        started = resolve;
      });
      const extension = {
        name: 'safe-recovery',
        tools: [
          defineTool({
            name: 'mcp_reference_lookup',
            description: 'native recovery fixture',
            parameters: Type.Object({ query: Type.String() }),
            replay: 'safe' as const,
            execute: async (_args, _api, context) => {
              calls++;
              started();
              if (calls === 1)
                await new Promise<void>((resolve) => {
                  context.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
                });
              return {
                output: [{ type: 'text' as const, text: 'safe recovery result' }],
                control: { terminate: true as const },
              };
            },
          }),
        ],
      };
      const openStorage = () =>
        openDurableObjectSqliteStorage(state.storage, { prefix: 'pi_tool_policy_' });
      let pi = await policyHarness({ storage: await openStorage(), extensions: [extension] });
      const root = await pi.root(c, {
        agent: { model: { provider: 'fixture', modelId: 'fixture' } },
      });
      await policyInput(pi, root, 'mcp lookup', 'recovery');
      await called;
      const policy = (await pi.snapshot(ConversationPolicy, String(root.id), c))!;
      if (narrow) await pi.commit((tx) => narrowConversationPolicy(tx, root.id, { tools: [] }), c);
      await pi.close(c);
      pi = await policyHarness({ storage: await openStorage(), extensions: [extension] });
      try {
        const recovered = (await pi.conversation(root.id, c))!;
        await recovered.waitForIdle(c);
        expect(calls).toBe(narrow ? 1 : 2);
        expect((await pi.snapshot(ExecutionScope, policy.scope!, c))!.tools).toHaveLength(1);
        if (narrow) expect((await pi.snapshot(AgentDoc, root.id, c))!.tools).toEqual([]);
      } finally {
        await pi.close(c);
      }
    });
  },
);
