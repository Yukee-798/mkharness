import { env, runInDurableObject, abortAllDurableObjects } from 'cloudflare:test';
import { expect, it } from 'vitest';
import {
  Type,
  type AssistantMessage,
  type Model,
  type Api,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { defineTool } from '@earendil-works/pi-durable';
import { fixtureModels, usage } from '../fixture-model';
import { SUGGESTIONS_TOOL } from '../../src/extensions/reply/suggestions';

type Mode =
  | 'text'
  | 'ui-first'
  | 'suggestions-first'
  | 'ui-failure'
  | 'work'
  | 'empty'
  | 'invalid'
  | 'disabled';
const prompts = ['Compare the extension boundaries', 'Trace host admission for a follow-up'];

async function probe(mode: Mode) {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const trace = { rounds: 0, work: 0, systems: [] as string[] };
  await runInDurableObject(stub, (instance) => {
    const target = instance as any;
    const contributions = target.contributions.bind(target);
    target.contributions = async () => [
      ...(await contributions()).filter((item: any) => mode !== 'disabled' || item.id !== 'reply'),
      {
        id: 'reply-work-probe',
        extension: {
          name: 'reply-work-probe',
          tools: [
            defineTool({
              name: 'reply_work',
              description: 'Test-only work with a committed effect',
              parameters: Type.Object({}),
              replay: 'unsafe',
              execute: async () => {
                await new Promise((resolve) => setTimeout(resolve, 80));
                trace.work++;
                return { output: [{ type: 'text', text: 'Work completed' }] };
              },
            }),
          ],
        },
      },
    ];
    target.models = () => {
      const models = fixtureModels();
      const stream = (model: Model<Api>, context: TranscriptContext) => {
        trace.rounds++;
        trace.systems = context.messages
          .filter((message) => message.role === 'system')
          .map((message) => JSON.stringify(message));
        const metadata: AssistantMessage['content'][number] = {
          type: 'toolCall',
          id: 'metadata',
          name: SUGGESTIONS_TOOL,
          arguments: { prompts: mode === 'invalid' ? ['x'.repeat(161)] : prompts },
        };
        const ui: AssistantMessage['content'][number] = {
          type: 'toolCall',
          id: 'display',
          name: 'present_openui',
          arguments: {
            ui:
              mode === 'ui-failure'
                ? 'broken('
                : 'root = Stack([TextContent("Extension boundaries")])',
          },
        };
        let content: AssistantMessage['content'];
        if (trace.rounds > 1 || mode === 'disabled')
          content = [{ type: 'text', text: 'Completed answer after the prior tools' }];
        else if (mode === 'text' || mode === 'invalid')
          content = [
            { type: 'text', text: 'The host admits each extension request once.' },
            metadata,
          ];
        else if (mode === 'empty') content = [metadata];
        else if (mode === 'work')
          content = [metadata, { type: 'toolCall', id: 'work', name: 'reply_work', arguments: {} }];
        else content = mode === 'ui-first' ? [ui, metadata] : [metadata, ui];
        const message: AssistantMessage = {
          role: 'assistant',
          content,
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage,
          stopReason: content.some((part) => part.type === 'toolCall') ? 'toolUse' : 'stop',
          timestamp: Date.now(),
        };
        const stream = new AssistantMessageEventStream();
        stream.push({ type: 'start', partial: { ...message, content: [] } });
        stream.push({
          type: 'done',
          reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop',
          message,
        });
        stream.end(message);
        return stream;
      };
      models.setProvider({
        ...models.getProviders().find((provider) => provider.id === 'fixture')!,
        stream,
        streamSimple: stream,
      });
      return models;
    };
  });
  const command = { runId: crypto.randomUUID(), text: 'Explain extension boundaries' };
  expect(await stub.submitRun(command)).toMatchObject({ accepted: true });
  await (await stub.observeRun(command.runId)).text();
  return { stub, command, trace, snapshot: JSON.parse(await stub.snapshot()) };
}

it.each(['text', 'ui-first', 'suggestions-first'] as const)(
  'commits %s answer and suggestions in one model round and restores their identity',
  async (mode) => {
    const { stub, trace, snapshot, command } = await probe(mode);
    expect(trace.rounds).toBe(1);
    expect(trace.systems.join('\n')).toContain('reply-followups');
    const answer = snapshot.entries.findLast((entry: any) => entry.kind === 'pi.assistant');
    expect(snapshot.extensionState.reply.replies).toEqual({ [answer.id]: prompts });
    const results = snapshot.entries
      .flatMap((entry: any) => entry.model ?? [])
      .filter((message: any) => message.role === 'toolResult');
    expect(results.find((message: any) => message.toolName === SUGGESTIONS_TOOL)).toMatchObject({
      isError: false,
    });
    if (mode !== 'text')
      expect(results.find((message: any) => message.toolName === 'present_openui')).toMatchObject({
        isError: false,
      });
    expect(await stub.submitRun(command)).toMatchObject({ accepted: true });
    expect(trace.rounds).toBe(1);
    await abortAllDurableObjects();
    const restored = JSON.parse(await env.CONVERSATIONS.get(stub.id).snapshot());
    expect(restored.extensionState.reply).toEqual(snapshot.extensionState.reply);
  },
);

it.each(['ui-failure', 'work', 'empty', 'invalid'] as const)(
  '%s keeps sibling outcomes and repair authoritative without stale suggestions',
  async (mode) => {
    const { trace, snapshot } = await probe(mode);
    expect(trace.rounds).toBe(2);
    if (mode === 'work') expect(trace.work).toBe(1);
    expect(snapshot.extensionState.reply.replies).toEqual({});
    const results = snapshot.entries
      .flatMap((entry: any) => entry.model ?? [])
      .filter((message: any) => message.role === 'toolResult');
    if (mode === 'ui-failure')
      expect(results.find((message: any) => message.toolName === 'present_openui')).toMatchObject({
        isError: true,
      });
    if (mode === 'empty' || mode === 'invalid')
      expect(results.find((message: any) => message.toolName === SUGGESTIONS_TOOL)).toMatchObject({
        isError: true,
      });
  },
);

it('removing the contribution removes its model instruction, tools and public projection', async () => {
  const { trace, snapshot } = await probe('disabled');
  expect(trace.rounds).toBe(1);
  expect(trace.systems.join('\n')).not.toContain('reply-followups');
  expect(snapshot.extensionState.reply).toBeUndefined();
});
