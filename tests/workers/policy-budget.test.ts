import { expect, it } from 'vitest';
import { defineTool, type ConversationId, type TaskId } from '@earendil-works/pi-durable';
import { Type, type AssistantMessage } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { env, runInDurableObject } from './env';
import { BG } from '../../src/server/chat/context';
import { ConversationPolicy, ExecutionScope } from '../../src/server/chat/policy';
import { usage } from '../fixture-model';

it.each([false, true])(
  'uses authorized queued root settings for tool successors without resetting the active input budget (queue C=%s)',
  async (queueC) => {
    const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
    let entered = false,
      release!: () => void,
      toolTask!: TaskId;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: { user: string; model: string; thinking: unknown }[] = [];
    await runInDurableObject(stub, (instance) => {
      const probe = instance as any,
        models = probe.models();
      const provider = models.getProvider('fixture')!;
      provider.streamSimple = (model: any, context: any, options: any) => {
        const content = context.messages.findLast(
          (message: any) => message.role === 'user',
        )?.content;
        const user =
          typeof content === 'string'
            ? content
            : (content ?? [])
                .filter((part: any) => part.type === 'text')
                .map((part: any) => part.text)
                .join('');
        calls.push({ user, model: model.id, thinking: options?.reasoning ?? 'off' });
        const first = user === 'A' && context.messages.at(-1)?.role === 'user';
        const message: AssistantMessage = {
          role: 'assistant',
          content: first
            ? [{ type: 'toolCall', id: 'held-tool', name: 'policy_gate', arguments: {} }]
            : [{ type: 'text', text: 'answer ' + user }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage,
          stopReason: first ? 'toolUse' : 'stop',
          timestamp: Date.now(),
        };
        const stream = new AssistantMessageEventStream();
        stream.push({ type: 'done', reason: message.stopReason as 'toolUse' | 'stop', message });
        stream.end(message);
        return stream;
      };
      probe.models = () => models;
      const contributions = probe.contributions.bind(instance);
      probe.contributions = async () => [
        ...(await contributions()),
        {
          id: 'policy-fixture',
          extension: {
            name: 'policy-fixture',
            tools: [
              defineTool({
                name: 'policy_gate',
                description: 'controlled production policy boundary',
                parameters: Type.Object({}),
                replay: 'safe' as const,
                execute: async (_args, api) => {
                  toolTask = api.taskId;
                  entered = true;
                  await held;
                  return { output: [{ type: 'text' as const, text: 'gate released' }] };
                },
              }),
            ],
          },
        },
      ];
    });
    const A = crypto.randomUUID(),
      B = crypto.randomUUID(),
      C = crypto.randomUUID();
    try {
      expect(
        await stub.submitRun({
          runId: A,
          text: 'A',
          config: { provider: 'fixture', modelId: 'fixture', thinkingLevel: 'low' },
        }),
      ).toMatchObject({ accepted: true });
      await expect.poll(() => entered).toBe(true);
      const initial = await runInDurableObject(stub, async (instance) => {
        const pi = await instance.harness.pi(),
          root = await instance.root();
        const policy = (await pi.snapshot(ConversationPolicy, String(root.id), BG))!;
        return {
          root: root.id,
          scope: policy.scope!,
          budget: await pi.snapshot(ExecutionScope, policy.scope!, BG),
        };
      });
      expect(initial.budget!.rounds).toHaveLength(1);
      expect(
        await stub.submitRun({
          runId: B,
          text: 'B',
          config: { provider: 'fixture', modelId: 'fixture-pro', thinkingLevel: 'high' },
        }),
      ).toMatchObject({ accepted: true });
      if (queueC)
        expect(
          await stub.submitRun({
            runId: C,
            text: 'C',
            config: { provider: 'fixture', modelId: 'fixture', thinkingLevel: 'high' },
          }),
        ).toMatchObject({ accepted: true });
      // The old tool's immutable authority remains restricted while root settings legitimately change.
      await runInDurableObject(stub, async (instance) => {
        const pi = await instance.harness.pi();
        const child = await pi.createConversation(
          { ownership: { kind: 'task', taskId: toolTask } },
          BG,
        );
        const policy = (await pi.snapshot(ConversationPolicy, String(child.id), BG))!;
        expect(policy.scope).toBe(initial.scope);
        expect(policy.models.map((model) => model.modelId)).toEqual(['fixture']);
        if (!queueC) {
          const input = await child.submit(
            { type: 'input', requestId: 'child', content: 'child cannot borrow queued model' },
            BG,
          );
          await child.waitForIdle(BG);
          expect(await input.status(BG)).toMatchObject({
            status: 'unanswered',
            detail: 'conversation_model_denied',
          });
        }
        expect((await pi.snapshot(ExecutionScope, initial.scope, BG))!.rounds).toHaveLength(1);
      });
      release();
      await expect.poll(async () => (await stub.submission(A))?.status).toBe('done');
      await expect.poll(async () => (await stub.submission(B))?.status).toBe('done');
      if (queueC) await expect.poll(async () => (await stub.submission(C))?.status).toBe('done');
      expect(calls).toEqual([
        { user: 'A', model: 'fixture', thinking: 'low' },
        { user: 'A', model: queueC ? 'fixture' : 'fixture-pro', thinking: 'high' },
        { user: 'B', model: queueC ? 'fixture' : 'fixture-pro', thinking: 'high' },
        ...(queueC ? [{ user: 'C', model: 'fixture', thinking: 'high' }] : []),
      ]);
      await runInDurableObject(stub, async (instance) => {
        const pi = await instance.harness.pi();
        expect((await pi.snapshot(ExecutionScope, initial.scope, BG))!.rounds).toHaveLength(2);
        expect((await pi.snapshot(ExecutionScope, initial.scope, BG))!.tools).toHaveLength(1);
        expect(
          (await pi.snapshot(ConversationPolicy, String(initial.root as ConversationId), BG))!
            .scope,
        ).not.toBe(initial.scope);
      });
    } finally {
      release();
    }
  },
);
