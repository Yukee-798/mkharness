import { expect, it, vi } from 'vitest';
import { Type, type AssistantMessage } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import {
  AgentDoc,
  Harness,
  MemoryStorage,
  createRegistry,
  GenerationTask,
  ToolTask,
  LiveDoc,
  defineTask,
  defineTool,
  configure,
  hook,
  type Conversation,
  type EntryId,
  type TaskId,
} from '@earendil-works/pi-durable';
import { fixtureModels, usage } from '../fixture-model';
import { guardModels } from '../../src/server/limits';
import {
  ConversationPolicy,
  admitExecutionPolicy,
  bindExecutionTask,
  ExecutionScope,
  authorizeExternalTarget,
  narrowConversationPolicy,
  reserveModel,
  reserveTool,
} from '../../src/server/chat/policy';
import {
  policyContext as c,
  policyHarness,
  policyInput,
  seedPolicyExecution,
} from '../policy-fixture';

function repeatingModels() {
  const models = fixtureModels();
  const provider = models.getProvider('fixture')!;
  const stream = vi.spyOn(provider, 'streamSimple').mockImplementation((model) => {
    const message: AssistantMessage = {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'A durable assistant round with a sufficiently long independent response for native compaction.',
        },
      ],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage,
      stopReason: 'stop',
      timestamp: Date.now(),
    };
    const out = new AssistantMessageEventStream();
    out.push({ type: 'done', reason: 'stop', message });
    out.end(message);
    return out;
  });
  return { models, stream };
}
const owner = defineTask({
  name: 'policy.owner',
  version: 1,
  initial: () => ({ phase: 'wait' as const }),
  phases: {
    wait: async (_task, runtime, _context) => {
      await new Promise<void>((resolve) =>
        runtime.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context);
  },
});
async function child(pi: Harness, parent: Conversation, at?: EntryId) {
  const taskId = await parent.commit(async (tx) => {
    const id = await tx.createTask(owner, {}, { ownership: { kind: 'conversation' } });
    await bindExecutionTask(tx, id, parent.id);
    return id;
  }, c);
  return at
    ? parent.fork(at, { ownership: { kind: 'task', taskId } }, c)
    : pi.createConversation({ ownership: { kind: 'task', taskId } }, c);
}
it('keeps the root input budget across real native compaction and onYield continuation', async () => {
  const { models, stream } = repeatingModels();
  let root!: Conversation,
    answers = 0,
    compacted = false;
  const extension = {
    name: 'continue-same-input',
    hooks: [
      hook(GenerationTask, {
        onYield: async () => {
          answers++;
          if (answers === 19) {
            const task = await root.compact(undefined, c);
            expect((await pi.waitForTask(task, c)).state.outcome.status).toBe('completed');
            compacted = true;
          }
          return { continue: 'Continue this same native input.' };
        },
      }),
    ],
  };
  const pi = await policyHarness({
    models,
    extensions: [extension],
    settings: { compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 10 } },
  });
  try {
    root = await pi.root(c, { agent: { model: { provider: 'fixture', modelId: 'fixture' } } });
    const submission = await policyInput(pi, root, 'same root input', 'one');
    await root.waitForIdle(c);
    const policy = (await pi.snapshot(ConversationPolicy, String(root.id), c))!;
    const scope = (await pi.snapshot(ExecutionScope, policy.scope!, c))!;
    expect(compacted).toBe(true);
    expect(scope.rounds).toHaveLength(20);
    expect(stream).toHaveBeenCalledTimes(20);
    expect(
      (await root.context(c)).entries.filter((e) => e.kind === 'pi.assistant').length,
    ).toBeLessThan(19);
    expect(await submission.status(c)).toMatchObject({
      status: 'unanswered',
      detail: expect.stringContaining('Model round limit reached (20)'),
    });
  } finally {
    await pi.close(c);
  }
});
it('atomically reserves shared tool budget, deduplicates the native ToolTask, and starts a fresh input scope', async () => {
  const pi = await policyHarness({ policy: { tools: ['probe'], limits: { toolCalls: 2 } } });
  try {
    const root = await pi.root(c);
    await seedPolicyExecution(pi, root);
    const tasks = await root.commit(
      async (tx) =>
        Promise.all(
          Array.from({ length: 3 }, (_, i) =>
            tx.createTask(
              ToolTask,
              {
                kind: 'nested',
                parent: 1 as any,
                parentCallId: 'parent',
                key: String(i),
                call: { type: 'toolCall', id: String(i), name: 'probe', arguments: {} },
              },
              { ownership: { kind: 'conversation' } },
            ),
          ),
        ),
      c,
    );
    const outcomes = await Promise.allSettled(
      tasks.map((id) => reserveTool(pi, root.id, id, 'probe', {}, c)),
    );
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(2);
    expect(
      (outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult).reason.message,
    ).toContain('Tool call limit reached (2)');
    await reserveTool(pi, root.id, tasks[0]!, 'probe', {}, c);
    const before = (await pi.snapshot(ConversationPolicy, String(root.id), c))!.scope!;
    await seedPolicyExecution(pi, root, 'fresh-input');
    const after = (await pi.snapshot(ConversationPolicy, String(root.id), c))!.scope!;
    expect(after).not.toBe(before);
    expect((await pi.snapshot(ExecutionScope, after, c))!.tools).toEqual([]);
  } finally {
    await pi.close(c);
  }
});
it('gives child/fork the same root budget and denies external targeting', async () => {
  const pi = await policyHarness({ extensions: [{ name: 'owner', tasks: [owner] }] });
  const root = await pi.root(c);
  await seedPolicyExecution(pi, root);
  const branch = await child(pi, root);
  const at = (await root.context(c)).entries.at(-1)!.id;
  const fork = await child(pi, root, at);
  const original = (await pi.snapshot(ConversationPolicy, String(root.id), c))!;
  expect((await pi.snapshot(ConversationPolicy, String(branch.id), c))!.scope).toBe(original.scope);
  expect((await pi.snapshot(ConversationPolicy, String(fork.id), c))!.scope).toBe(original.scope);
  await expect(authorizeExternalTarget(pi, branch.id, c)).rejects.toThrow(
    'external_conversation_denied',
  );
  try {
    await reserveModel(pi, root.id, { provider: 'fixture', modelId: 'fixture' }, c);
    expect((await pi.snapshot(ExecutionScope, original.scope!, c))!.rounds).toHaveLength(1);
    await seedPolicyExecution(pi, root, 'new-root');
    await seedPolicyExecution(pi, branch, 'long-lived-child');
    expect((await pi.snapshot(ExecutionScope, original.scope!, c))!.rounds).toHaveLength(2);
    expect((await pi.snapshot(ConversationPolicy, String(branch.id), c))!.scope).toBe(
      original.scope,
    );
  } finally {
    await pi.close(c);
  }
});
it('applies depth, total, concurrency and capability shrinkage without trusting inherited native agent authority', async () => {
  const pi = await policyHarness({
    extensions: [{ name: 'owner', tasks: [owner] }],
    policy: {
      tools: ['probe', 'remote', 'activate_skill'],
      mcp: ['one'],
      skills: ['skill-one'],
      toolScopes: { remote: { mcp: 'one' } },
      skillNames: { guide: 'skill-one' },
      limits: { childDepth: 1, childTotal: 3, childConcurrent: 1 },
    },
  });
  try {
    const root = await pi.root(c);
    await seedPolicyExecution(pi, root);
    const branch = await child(pi, root);
    await expect(child(pi, branch)).rejects.toThrow('child_depth_limit');
    await pi.commit(
      (tx) => narrowConversationPolicy(tx, branch.id, { tools: ['probe'], mcp: [], skills: [] }),
      c,
    );
    expect((await pi.snapshot(AgentDoc, branch.id, c))!.tools).toEqual(['probe']);
    await expect(
      pi.commit((tx) => narrowConversationPolicy(tx, branch.id, { tools: ['unknown'] }), c),
    ).rejects.toThrow('conversation_policy_expansion');
    await expect(
      pi.commit(
        (tx) =>
          narrowConversationPolicy(tx, branch.id, {
            models: [{ provider: 'unbound', modelId: 'fixture' }],
          }),
        c,
      ),
    ).rejects.toThrow('conversation_policy_expansion');
    const scopeKey = (await pi.snapshot(ConversationPolicy, String(root.id), c))!.scope!;
    await pi.commit(async (tx) => {
      (await tx.doc(ExecutionScope, scopeKey, null)).active.push(Number(branch.id));
      const live = await tx.doc(LiveDoc, branch.id);
      live.run = { taskId: 999 as any, inputs: [] };
    }, c);
    await expect(child(pi, root)).rejects.toThrow('child_concurrency_limit');
    await pi.commit(async (tx) => {
      delete (await tx.doc(LiveDoc, branch.id)).run;
    }, c);
    await child(pi, root);
    await child(pi, root);
    await expect(child(pi, root)).rejects.toThrow('child_total_limit');
  } finally {
    await pi.close(c);
  }
});
it('fails closed without a native target, current policy, input grant or approved bound model', async () => {
  const models = fixtureModels(),
    network = vi.spyOn(models.getProvider('fixture')!, 'streamSimple');
  const lookup = vi.fn(async () => {
    throw new Error('Policy denied this target');
  });
  const guarded = guardModels(models, lookup),
    model = models.getModel('fixture', 'fixture')!;
  expect((await guarded.completeSimple(model, { messages: [] })).errorMessage).toBe(
    'Model request target is missing',
  );
  expect(
    (await guarded.completeSimple(model, { messages: [] }, { sessionId: 'missing' })).errorMessage,
  ).toBe('Policy denied this target');
  expect(network).not.toHaveBeenCalled();
  const pi = await policyHarness();
  try {
    const root = await pi.root(c);
    await seedPolicyExecution(pi, root);
    await expect(
      reserveModel(pi, root.id, { provider: 'unbound', modelId: 'fixture' }, c),
    ).rejects.toThrow('native_model_request_missing');
    await expect(pi.createConversation({ ownership: { kind: 'ownerless' } }, c)).rejects.toThrow(
      'conversation_creation_denied',
    );
  } finally {
    await pi.close(c);
  }
});
it('shares actual provider budget with child and externally addressable ownerless fork', async () => {
  const { models, stream } = repeatingModels();
  const pi = await policyHarness({
    models,
    extensions: [{ name: 'owner', tasks: [owner] }],
    policy: { limits: { modelRounds: 2 } },
  });
  try {
    const root = await pi.root(c, {
      agent: { model: { provider: 'fixture', modelId: 'fixture' } },
    });
    await policyInput(pi, root, 'root request', 'root');
    await root.waitForIdle(c);
    const branch = await child(pi, root);
    await branch.submit({ type: 'input', content: 'child request', requestId: 'child' }, c);
    await branch.waitForIdle(c);
    const at = (await root.context(c)).entries.at(-1)!.id;
    const fork = await root.fork(at, { ownership: { kind: 'ownerless' } }, c);
    await expect(authorizeExternalTarget(pi, fork.id, c)).resolves.toBeUndefined();
    const input = await policyInput(pi, fork, 'fork request', 'fork');
    await fork.waitForIdle(c);
    expect(stream).toHaveBeenCalledTimes(2);
    expect(await input.status(c)).toMatchObject({
      status: 'unanswered',
      detail: expect.stringContaining('Model round limit reached (2)'),
    });
    const scope = (await pi.snapshot(ConversationPolicy, String(root.id), c))!.scope!;
    expect((await pi.snapshot(ConversationPolicy, String(fork.id), c))!.scope).toBe(scope);
    expect((await pi.snapshot(ExecutionScope, scope, c))!.rounds).toHaveLength(2);
    await expect(
      pi.commit(
        (tx) =>
          admitExecutionPolicy(tx, fork.id, 'escape', {
            model: { provider: 'unbound', modelId: 'fixture' },
          }),
        c,
      ),
    ).rejects.toThrow('conversation_model_denied');
  } finally {
    await pi.close(c);
  }
});
it('shrinks MCP and Skills independently from tool names, and never widens a narrowed parent through another child', async () => {
  const pi = await policyHarness({
    extensions: [{ name: 'owner', tasks: [owner] }],
    policy: {
      tools: ['remote', 'activate_skill'],
      mcp: ['one'],
      skills: ['skill-one'],
      toolScopes: { remote: { mcp: 'one' } },
      skillNames: { guide: 'skill-one' },
    },
  });
  try {
    const root = await pi.root(c);
    await seedPolicyExecution(pi, root);
    const branch = await child(pi, root);
    await pi.commit(
      (tx) => narrowConversationPolicy(tx, branch.id, { mcp: [], skills: [], models: [] }),
      c,
    );
    const grandchild = await child(pi, branch);
    expect((await pi.snapshot(ConversationPolicy, String(grandchild.id), c))!.models).toEqual([]);
    const tasks = await branch.commit(
      async (tx) =>
        Promise.all(
          ['remote', 'activate_skill'].map((name) =>
            tx.createTask(
              ToolTask,
              {
                kind: 'nested',
                parent: 1 as any,
                parentCallId: 'fixture',
                key: name,
                call: { type: 'toolCall', id: name, name, arguments: {} },
              },
              { ownership: { kind: 'conversation' } },
            ),
          ),
        ),
      c,
    );
    await expect(reserveTool(pi, branch.id, tasks[0]!, 'remote', {}, c)).rejects.toThrow(
      'conversation_mcp_denied',
    );
    await expect(
      reserveTool(pi, branch.id, tasks[1]!, 'activate_skill', { name: 'guide' }, c),
    ).rejects.toThrow('conversation_skill_denied');
  } finally {
    await pi.close(c);
  }
});
it.each(['rounds', 'concurrency'] as const)(
  'atomically arbitrates parallel native child model reservations (%s)',
  async (limit) => {
    const pi = await policyHarness({
      extensions: [{ name: 'owner', tasks: [owner] }],
      policy: {
        limits: {
          modelRounds: limit === 'rounds' ? 2 : 20,
          childConcurrent: limit === 'concurrency' ? 1 : 3,
        },
      },
    });
    try {
      const root = await pi.root(c);
      await seedPolicyExecution(pi, root);
      const one = await child(pi, root),
        two = await child(pi, root);
      const outcomes = await Promise.allSettled([
        seedPolicyExecution(pi, one, 'one'),
        seedPolicyExecution(pi, two, 'two'),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(
        (outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult).reason
          .message,
      ).toContain(limit === 'rounds' ? 'Model round limit reached (2)' : 'child_concurrency_limit');
      const scope = (await pi.snapshot(
        ExecutionScope,
        (await pi.snapshot(ConversationPolicy, String(root.id), c))!.scope!,
        c,
      ))!;
      expect(scope.rounds).toHaveLength(2);
      expect(scope.active).toHaveLength(1);
    } finally {
      await pi.close(c);
    }
  },
);
it('denies native model execution with no policy or no current input grant', async () => {
  for (const absent of ['policy', 'grant']) {
    const models = fixtureModels(),
      network = vi.spyOn(models.getProvider('fixture')!, 'streamSimple');
    const pi: Harness =
      absent === 'policy'
        ? await Harness.open(
            new MemoryStorage(),
            {
              models: guardModels(models, async () => ({
                pi,
                conversationId: 1,
                entries: [],
                context: c,
              })),
              registry: createRegistry(),
            },
            c,
          )
        : await policyHarness({ models });
    try {
      const root = await pi.root(c, {
        agent: { model: { provider: 'fixture', modelId: 'fixture' } },
      });
      const input = await root.submit(
        { type: 'input', content: 'missing authority', requestId: 'no-grant' },
        c,
      );
      await root.waitForIdle(c);
      expect(await input.status(c)).toMatchObject({
        status: 'unanswered',
        detail: 'execution_policy_missing',
      });
      expect(network).not.toHaveBeenCalled();
    } finally {
      await pi.close(c);
    }
  }
});
it('closes native model work while policy awaits host initialization and observes a late denial', async () => {
  const models = fixtureModels(),
    network = vi.spyOn(models.getProvider('fixture')!, 'streamSimple');
  let reject!: (error: Error) => void;
  const held = new Promise<import('../../src/server/limits').RunGuardContext>(
    (_resolve, failed) => {
      reject = failed;
    },
  );
  const lookup = vi.fn(() => held);
  const pi = await policyHarness({ models: guardModels(models, lookup) });
  try {
    const root = await pi.root(c, {
      agent: { model: { provider: 'fixture', modelId: 'fixture' } },
    });
    await policyInput(pi, root, 'waiting initialization', 'wait');
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
    await pi.close(c);
    expect(await pi.closed).toEqual({ reason: 'closed' });
    expect(network).not.toHaveBeenCalled();
    reject(new Error('late policy denial'));
    await Promise.resolve();
  } finally {
    reject(new Error('cleanup'));
    await pi.close(c);
  }
});
it('pins an old native owner task when it creates a child after the root starts another input', async () => {
  const pi = await policyHarness({ extensions: [{ name: 'owner', tasks: [owner] }] });
  try {
    const root = await pi.root(c);
    await seedPolicyExecution(pi, root, 'first');
    const oldScope = (await pi.snapshot(ConversationPolicy, String(root.id), c))!.scope!;
    const taskId = await root.commit(async (tx) => {
      const task = await tx.createTask(owner, {}, { ownership: { kind: 'conversation' } });
      await bindExecutionTask(tx, task, root.id);
      return task;
    }, c);
    await seedPolicyExecution(pi, root, 'second');
    const newScope = (await pi.snapshot(ConversationPolicy, String(root.id), c))!.scope!;
    const branch = await pi.createConversation({ ownership: { kind: 'task', taskId } }, c);
    await seedPolicyExecution(pi, branch, 'old-owner-child');
    expect((await pi.snapshot(ConversationPolicy, String(branch.id), c))!.scope).toBe(oldScope);
    expect((await pi.snapshot(ExecutionScope, oldScope, c))!.rounds).toHaveLength(2);
    expect((await pi.snapshot(ExecutionScope, newScope, c))!.rounds).toHaveLength(1);
    const unbound = await root.commit(
      (tx) => tx.createTask(owner, {}, { ownership: { kind: 'conversation' } }),
      c,
    );
    await expect(
      pi.createConversation({ ownership: { kind: 'task', taskId: unbound } }, c),
    ).rejects.toThrow('execution_policy_missing');
  } finally {
    await pi.close(c);
  }
});
it('binds a delayed ToolTask to its generating task when queued settings change before tool admission', async () => {
  const pi = await policyHarness({ policy: { tools: ['probe'] } });
  try {
    const root = await pi.root(c);
    await seedPolicyExecution(pi, root, 'A');
    const generation = (await pi.snapshot(LiveDoc, root.id, c))!.run!.taskId;
    const tool = await root.commit(async (tx) => {
      await admitExecutionPolicy(tx, root.id, 'B', {
        model: { provider: 'fixture', modelId: 'fixture-pro' },
      });
      return tx.createTask(
        ToolTask,
        {
          kind: 'nested',
          parent: generation,
          parentCallId: 'fixture',
          key: 'delayed',
          call: { type: 'toolCall', id: 'delayed', name: 'probe', arguments: {} },
        },
        { ownership: { kind: 'task', taskId: generation } },
      );
    }, c);
    await reserveTool(pi, root.id, tool, 'probe', {}, c);
    const branch = await pi.createConversation({ ownership: { kind: 'task', taskId: tool } }, c);
    expect(
      (await pi.snapshot(ConversationPolicy, String(root.id), c))!.models.map(
        (model) => model.modelId,
      ),
    ).toEqual(['fixture-pro']);
    expect(
      (await pi.snapshot(ConversationPolicy, String(branch.id), c))!.models.map(
        (model) => model.modelId,
      ),
    ).toEqual(['fixture']);
  } finally {
    await pi.close(c);
  }
});
it('runs an authorized ownerless fork before the parent uses queued settings without broadening the old tool owner', async () => {
  let entered!: () => void, release!: () => void, toolTask!: TaskId;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const models = fixtureModels(),
    network = vi.spyOn(models.getProvider('fixture')!, 'streamSimple');
  const pi = await policyHarness({
    models,
    extensions: [
      {
        name: 'fork-before-successor',
        tools: [
          defineTool({
            name: 'mcp_reference_lookup',
            description: 'controlled tool gap',
            parameters: Type.Object({ query: Type.String() }),
            replay: 'safe',
            execute: async (_args, api) => {
              toolTask = api.taskId;
              entered();
              await held;
              return { output: [{ type: 'text', text: 'done' }] };
            },
          }),
        ],
      },
    ],
  });
  try {
    const root = await pi.root(c, {
      agent: { model: { provider: 'fixture', modelId: 'fixture' } },
    });
    const A = await policyInput(pi, root, 'mcp lookup', 'A');
    await started;
    const scopeKey = (await pi.snapshot(ConversationPolicy, String(root.id), c))!.scope!;
    const before = (await pi.snapshot(ExecutionScope, scopeKey, c))!;
    expect(before.models.map((model) => model.modelId)).toEqual(['fixture']);
    await root.commit(async (tx) => {
      await admitExecutionPolicy(tx, root.id, 'B', {
        model: { provider: 'fixture', modelId: 'fixture-pro' },
      });
      await configure(tx, root.id, { model: { provider: 'fixture', modelId: 'fixture-pro' } });
    }, c);
    const B = await root.submit(
      { type: 'input', requestId: 'B', content: 'queued B', whenBusy: 'followUp' },
      c,
    );
    expect(
      (await pi.snapshot(ExecutionScope, scopeKey, c))!.models.map((model) => model.modelId),
    ).toEqual(['fixture']);
    const owned = await pi.createConversation({ ownership: { kind: 'task', taskId: toolTask } }, c);
    // A display-only marker captures the current native B agent for the fork's as-of document copy.
    const at = await root.commit((tx) => tx.appendEntry(root.id, { kind: 'test.fork-point' }), c);
    const fork = await root.fork(at.id, { ownership: { kind: 'ownerless' } }, c);
    expect((await pi.snapshot(AgentDoc, fork.id, c))!.model!.modelId).toBe('fixture-pro');
    const input = await policyInput(pi, fork, 'fork runs B first', 'fork', {
      provider: 'fixture',
      modelId: 'fixture-pro',
    });
    await fork.waitForIdle(c);
    expect(await input.status(c)).toMatchObject({ status: 'done' });
    expect(await A.status(c)).toMatchObject({ status: 'placed' });
    expect(await B.status(c)).toMatchObject({ status: 'queued' });
    expect(network.mock.calls.map(([model]) => model.id)).toEqual(['fixture', 'fixture-pro']);
    expect(
      (await pi.snapshot(ConversationPolicy, String(owned.id), c))!.models.map(
        (model) => model.modelId,
      ),
    ).toEqual(['fixture']);
    expect((await pi.snapshot(ConversationPolicy, String(fork.id), c))!.scope).toBe(scopeKey);
    expect((await pi.snapshot(ConversationPolicy, String(root.id), c))!.scope).toBe(scopeKey);
    const shared = (await pi.snapshot(ExecutionScope, scopeKey, c))!;
    expect(shared.inputId).toBe(before.inputId);
    expect(shared.rounds).toHaveLength(2);
    expect(shared.tools).toHaveLength(1);
    release();
    await root.waitForIdle(c);
  } finally {
    release();
    await pi.close(c);
  }
});
