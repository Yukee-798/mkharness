import {
  Harness,
  GenerationTask,
  LiveDoc,
  MemoryStorage,
  ProviderDoc,
  createRegistry,
  type Extension,
  type Storage,
  type Conversation,
} from '@earendil-works/pi-durable';
import type { Models } from '@earendil-works/pi-ai/models';
import { fixtureModels } from './fixture-model';
import { guardModels, guardTools, runLimits } from '../src/server/limits';
import { ModelTarget } from '../src/server/chat/documents';
import {
  admitExecutionPolicy,
  createConversationPolicy,
  ConversationPolicy,
  reserveModel,
  type RuntimePolicy,
} from '../src/server/chat/policy';
export const policyContext = {
  abortSignal: undefined,
  value: () => undefined,
  toString: () => '[policy-test]',
};
export async function policyHarness(
  options: {
    models?: Models;
    storage?: Storage;
    extensions?: Extension[];
    policy?: Partial<RuntimePolicy>;
    settings?: Parameters<typeof Harness.open>[1]['settings'];
  } = {},
) {
  const registry = createRegistry(),
    models = options.models ?? fixtureModels();
  const extensions = options.extensions ?? [];
  const policy: RuntimePolicy = {
    tools: extensions.flatMap((e) => e.tools ?? []).map((t) => t.name),
    mcp: [],
    skills: [],
    ...options.policy,
  };
  for (const extension of [...extensions, runLimits(async () => pi)])
    registry.install(guardTools(extension, async () => pi));
  const pi: Harness = await Harness.open(
    options.storage ?? new MemoryStorage(),
    {
      models: guardModels(models, async (sessionId) => {
        const target = await pi.snapshot(ModelTarget, sessionId, policyContext);
        if (!target) throw new Error('Model target missing');
        return { pi, conversationId: target.conversationId, entries: [], context: policyContext };
      }),
      registry,
      settings: options.settings,
      conversationCreated: async (tx, conversation) => {
        await createConversationPolicy(tx, conversation, policy);
        await tx.doc(ModelTarget, (await tx.doc(ProviderDoc, conversation.id)).sessionId, {
          conversationId: Number(conversation.id),
        });
      },
    },
    policyContext,
  );
  return pi;
}
export async function policyInput(
  pi: Harness,
  conversation: Conversation,
  text: string,
  requestId: string,
  model = { provider: 'fixture', modelId: 'fixture' },
) {
  await pi.commit(
    (tx) => admitExecutionPolicy(tx, conversation.id, requestId, { model }),
    policyContext,
  );
  return conversation.submit({ type: 'input', content: text, requestId }, policyContext);
}

export async function seedPolicyExecution(
  pi: Harness,
  root: Conversation,
  requestId = 'root-input',
) {
  await pi.commit(async (tx) => {
    if ((await tx.doc(ConversationPolicy, String(root.id), null)).depth === 0)
      await admitExecutionPolicy(tx, root.id, requestId, {
        model: { provider: 'fixture', modelId: 'fixture' },
      });
    const entry = await tx.appendEntry(root.id, {
      kind: 'app.input',
      model: [{ role: 'user', content: requestId, timestamp: 1 }],
    });
    const input = await tx.createSubmission({
      type: 'input',
      conversationId: root.id,
      requestId,
      status: 'placed',
      entry: entry.id,
    });
    const taskId = await tx.createTask(
      {
        definition: {
          ...GenerationTask.definition,
          initial: () => ({
            phase: 'request' as const,
            attempt: 1,
            model: { provider: 'fixture', modelId: 'fixture' },
            thinkingLevel: 'off' as const,
            streamOptions: {},
            cutoff: entry.id,
          }),
        },
      },
      {},
      { ownership: { kind: 'conversation' }, conversationId: root.id },
    );
    (await tx.doc(LiveDoc, root.id)).run = { taskId, inputs: [input.id] };
  }, policyContext);
  await reserveModel(pi, root.id, { provider: 'fixture', modelId: 'fixture' }, policyContext);
}
