import {
  LiveDoc,
  AgentDoc,
  GenerationTask,
  CompactionTask,
  ROOT_CONVERSATION_ID,
  defineDocFamily,
  type ConversationId,
  type ConversationRecord,
  type Harness,
  type ModelRef,
  type TaskId,
  type Tx,
} from '@earendil-works/pi-durable';
import { AppError } from '../../shared/contracts';

export type PolicyLimits = {
  modelRounds: number;
  toolCalls: number;
  childDepth: number;
  childTotal: number;
  childConcurrent: number;
};
export const DEFAULT_POLICY_LIMITS: PolicyLimits = {
  modelRounds: 20,
  toolCalls: 40,
  childDepth: 3,
  childTotal: 8,
  childConcurrent: 3,
};
export type PolicyCapabilities = {
  tools: string[];
  mcp: string[];
  skills: string[];
  toolScopes?: Record<string, { mcp?: string }>;
  skillNames?: Record<string, string>;
};
export type RuntimePolicy = PolicyCapabilities & { limits?: Partial<PolicyLimits> };
type Policy = PolicyCapabilities & {
  rootId: number;
  parentId?: number;
  depth: number;
  external: boolean;
  limits: PolicyLimits;
  models: ModelRef[];
  modelCeiling?: ModelRef[];
  scope?: string;
};
type Scope = {
  rootId: number;
  inputId: number;
  models: ModelRef[];
  rounds: number[];
  tools: number[];
  children: number[];
  active: number[];
};
const missing = () => new AppError(503, 'execution_policy_missing');
export const ConversationPolicy = defineDocFamily<Policy, Policy | null>({
  kind: 'app.conversation-policy',
  version: 1,
  scope: 'session',
  family: true,
  initial: (seed) => {
    if (!seed) throw missing();
    return structuredClone(seed);
  },
});
export const ExecutionScope = defineDocFamily<Scope, Scope | null>({
  kind: 'app.execution-scope',
  version: 1,
  scope: 'session',
  family: true,
  initial: (seed) => {
    if (!seed) throw missing();
    return structuredClone(seed);
  },
});
const InputGrant = defineDocFamily<{ models: ModelRef[] }, { models: ModelRef[] } | null>({
  kind: 'app.input-grant',
  version: 1,
  scope: 'session',
  family: true,
  initial: (seed) => {
    if (!seed) throw missing();
    return structuredClone(seed);
  },
});
/** Root settings are authorized at admission, independently of which input currently owns the budget.
 * Native successor/retry preparation uses the latest settings, including settings of queued inputs. */
const RootModelGrant = defineDocFamily<{ allowed: true }, true | null>({
  kind: 'app.root-model-grant',
  version: 1,
  scope: 'session',
  family: true,
  initial: (seed) => {
    if (seed !== true) throw missing();
    return { allowed: true };
  },
});
const rootModelKey = (rootId: number, model: ModelRef) =>
  JSON.stringify([rootId, model.provider, model.modelId]);
const TaskExecutionPolicy = defineDocFamily<{ policy: Policy }, { policy: Policy } | null>({
  kind: 'app.task-execution-policy',
  version: 1,
  scope: 'session',
  family: true,
  initial: (seed) => {
    if (!seed) throw missing();
    return structuredClone(seed);
  },
});
/** Trusted task creators bind authority in the task's creating commit. Pass the calling task when spawning
 * from a task: a background owner must never borrow its conversation's later input grant. */
export async function bindExecutionTask(
  tx: Tx,
  taskId: TaskId,
  conversationId: ConversationId,
  fromTaskId?: TaskId,
) {
  const policy =
    fromTaskId === undefined
      ? await policyDoc(tx, conversationId)
      : (await tx.doc(TaskExecutionPolicy, String(fromTaskId), null)).policy;
  if (!policy.scope) throw missing();
  const binding = await tx.doc(TaskExecutionPolicy, String(taskId), { policy: copy(policy) });
  if (binding.policy.scope !== policy.scope)
    throw new AppError(403, 'task_execution_scope_conflict');
}
const policyDoc = (tx: Tx, id: ConversationId) => tx.doc(ConversationPolicy, String(id), null);
const sameModel = (a: ModelRef, b: ModelRef) =>
  a.provider === b.provider && a.modelId === b.modelId;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function limits(input?: Partial<PolicyLimits>): PolicyLimits {
  const value = { ...DEFAULT_POLICY_LIMITS, ...input };
  for (const [key, limit] of Object.entries(value))
    if (
      !Number.isSafeInteger(limit) ||
      limit < (key === 'childDepth' || key === 'childTotal' ? 0 : 1)
    )
      throw new AppError(503, 'execution_policy_limits_invalid');
  return value;
}
/** Called in Pi's creating transaction; policy is not a rewindable/fork-copy document. */
export async function createConversationPolicy(
  tx: Tx,
  conversation: ConversationRecord,
  configured?: RuntimePolicy,
) {
  const parentId = conversation.owner?.conversationId ?? conversation.parent?.conversationId;
  if (!parentId) {
    if (conversation.id !== ROOT_CONVERSATION_ID)
      throw new AppError(403, 'conversation_creation_denied');
    const root: Policy = {
      rootId: Number(conversation.id),
      depth: 0,
      external: true,
      models: [],
      tools: configured?.tools ?? [],
      mcp: configured?.mcp ?? [],
      skills: configured?.skills ?? [],
      toolScopes: configured?.toolScopes ?? {},
      skillNames: configured?.skillNames ?? {},
      limits: limits(configured?.limits),
    };
    await tx.doc(ConversationPolicy, String(conversation.id), root);
    (await tx.doc(AgentDoc, conversation.id)).tools = [...root.tools];
    return;
  }
  const currentParent = await policyDoc(tx, parentId);
  const parent = conversation.owner
    ? copy((await tx.doc(TaskExecutionPolicy, String(conversation.owner.taskId), null)).policy)
    : copy(currentParent);
  if (parent.rootId !== currentParent.rootId || parent.depth !== currentParent.depth)
    throw new AppError(403, 'task_execution_scope_conflict');
  for (const key of ['tools', 'mcp', 'skills'] as const)
    parent[key] = parent[key].filter((value) => currentParent[key].includes(value));
  for (const key of Object.keys(parent.limits) as (keyof PolicyLimits)[])
    parent.limits[key] = Math.min(parent.limits[key], currentParent.limits[key]);
  if (currentParent.modelCeiling)
    parent.models = parent.models.filter((model) =>
      currentParent.modelCeiling!.some((allowed) => sameModel(allowed, model)),
    );
  if (!parent.scope) throw missing();
  if (conversation.parent && conversation.owner) {
    const source = await policyDoc(tx, conversation.parent.conversationId);
    if (source.scope !== parent.scope) throw new AppError(403, 'conversation_scope_denied');
  }
  const scope = await tx.doc(ExecutionScope, parent.scope, null);
  if (parent.depth >= parent.limits.childDepth) throw new AppError(429, 'child_depth_limit');
  if (scope.children.length >= parent.limits.childTotal)
    throw new AppError(429, 'child_total_limit');
  const active: number[] = [];
  for (const id of scope.active)
    if ((await tx.doc(LiveDoc, id as ConversationId)).run) active.push(id);
  scope.active = active;
  if (active.length >= parent.limits.childConcurrent)
    throw new AppError(429, 'child_concurrency_limit');
  const policy: Policy = {
    ...copy(parent),
    parentId: Number(parentId),
    depth: parent.depth + 1,
    external: !conversation.owner && parent.external,
    models: copy(parent.models),
  };
  await tx.doc(ConversationPolicy, String(conversation.id), policy);
  scope.children.push(Number(conversation.id));
  for (const model of policy.models)
    if (!scope.models.some((allowed) => sameModel(allowed, model))) scope.models.push(copy(model));
  (await tx.doc(AgentDoc, conversation.id)).tools = [...policy.tools];
}
/** A host may narrow a branch in its creation init; inherited capabilities can never expand. */
export async function narrowConversationPolicy(
  tx: Tx,
  id: ConversationId,
  change: Partial<PolicyCapabilities> & { models?: ModelRef[]; limits?: Partial<PolicyLimits> },
) {
  const policy = await policyDoc(tx, id);
  for (const key of ['tools', 'mcp', 'skills'] as const) {
    const values = change[key];
    if (!values) continue;
    if (values.some((value) => !policy[key].includes(value)))
      throw new AppError(403, 'conversation_policy_expansion');
    policy[key] = [...values];
    if (key === 'tools') (await tx.doc(AgentDoc, id)).tools = [...values];
  }
  if (change.toolScopes || change.skillNames)
    throw new AppError(403, 'conversation_policy_expansion');
  if (change.models) {
    if (change.models.some((model) => !policy.models.some((allowed) => sameModel(model, allowed))))
      throw new AppError(403, 'conversation_policy_expansion');
    policy.models = copy(change.models);
    policy.modelCeiling = copy(change.models);
  }
  if (change.limits) {
    const proposed = limits({ ...policy.limits, ...change.limits });
    for (const key of Object.keys(proposed) as (keyof PolicyLimits)[])
      if (proposed[key] > policy.limits[key])
        throw new AppError(403, 'conversation_policy_expansion');
    policy.limits = proposed;
  }
}
/** Admission records authority, but never changes the currently placed input's scope. */
export async function admitExecutionPolicy(
  tx: Tx,
  id: ConversationId,
  requestId: string,
  grant: { model: ModelRef },
) {
  const policy = await policyDoc(tx, id);
  if (!policy.external) throw new AppError(403, 'external_conversation_denied');
  if (policy.depth > 0 && !policy.models.some((model) => sameModel(model, grant.model)))
    throw new AppError(403, 'conversation_model_denied');
  const value = await tx.doc(InputGrant, `${id}:${requestId}`, { models: [grant.model] });
  if (!value.models.some((model) => sameModel(model, grant.model)))
    throw new AppError(409, 'execution_grant_conflict');
  if (policy.depth === 0) {
    if (
      policy.modelCeiling &&
      !policy.modelCeiling.some((allowed) => sameModel(allowed, grant.model))
    )
      throw new AppError(403, 'conversation_model_denied');
    await tx.doc(RootModelGrant, rootModelKey(policy.rootId, grant.model), true);
    policy.models = [copy(grant.model)];
  }
}
export async function authorizeExternalTarget(
  pi: Harness,
  id: ConversationId,
  context: Parameters<Harness['close']>[0],
) {
  const policy = await pi.snapshot(ConversationPolicy, String(id), context);
  if (!policy) throw missing();
  if (!policy.external) throw new AppError(403, 'external_conversation_denied');
}
async function nativeInput(
  pi: Harness,
  id: ConversationId,
  context: Parameters<Harness['close']>[0],
) {
  const live = await pi.snapshot(LiveDoc, id, context);
  const inputId = live?.run?.inputs[0];
  if (!inputId) return;
  const requestIds: string[] = [];
  for (const id of live!.run!.inputs) {
    const submission = await pi.submission(id, context);
    const status = await submission?.status(context);
    if (!status || status.type !== 'input' || !status.requestId) throw missing();
    requestIds.push(status.requestId);
  }
  return { inputId: Number(inputId), requestIds };
}
async function executionScope(
  tx: Tx,
  id: ConversationId,
  input: Awaited<ReturnType<typeof nativeInput>>,
) {
  const policy = await policyDoc(tx, id);
  if (policy.depth === 0 && input) {
    const live = await tx.doc(LiveDoc, id);
    if (Number(live.run?.inputs[0]) !== input.inputId)
      throw new AppError(409, 'execution_input_changed');
    const models: ModelRef[] = [];
    for (const requestId of input.requestIds) {
      const grant = await tx.doc(InputGrant, `${id}:${requestId}`, null);
      for (const model of grant.models)
        if (!models.some((allowed) => sameModel(allowed, model))) models.push(copy(model));
    }
    const key = `${policy.rootId}:${input.inputId}`;
    const scope = await tx.doc(ExecutionScope, key, {
      rootId: policy.rootId,
      inputId: input.inputId,
      models: copy(models),
      rounds: [],
      tools: [],
      children: [],
      active: [],
    });
    policy.scope = key;
    for (const model of models)
      if (!scope.models.some((allowed) => sameModel(allowed, model)))
        scope.models.push(copy(model));
    return { policy, scope };
  }
  if (!policy.scope) throw missing();
  return { policy, scope: await tx.doc(ExecutionScope, policy.scope, null) };
}
async function reserveChild(tx: Tx, id: ConversationId, policy: Policy, scope: Scope) {
  if (policy.depth === 0) return;
  const active: number[] = [];
  for (const other of scope.active)
    if ((await tx.doc(LiveDoc, other as ConversationId)).run) active.push(other);
  if (!active.includes(Number(id))) {
    if (active.length >= policy.limits.childConcurrent)
      throw new AppError(429, 'child_concurrency_limit');
    active.push(Number(id));
  }
  scope.active = active;
}
/** A summary can commit selection, then outlive its input before its first network request. Pin its
 * input authority at beforeCompact, not by whichever input happens to be current at dispatch/recovery. */
export async function bindNativeExecutionTask(
  pi: Harness,
  id: ConversationId,
  taskId: TaskId,
  context: Parameters<Harness['close']>[0],
) {
  const input = await nativeInput(pi, id, context);
  await pi.commit(async (tx) => {
    const { policy } = await executionScope(tx, id, input);
    const binding = await tx.doc(TaskExecutionPolicy, String(taskId), { policy: copy(policy) });
    if (!binding.policy.scope) throw missing();
  }, context);
}
/** The reservation commit is the only authority to start a native prepared request. */
export async function reserveModel(
  pi: Harness,
  id: ConversationId,
  model: ModelRef,
  context: Parameters<Harness['close']>[0],
) {
  const input = await nativeInput(pi, id, context);
  await pi.commit(async (tx) => {
    // Read native records before document changes. Pi exposes one provider session per conversation, so concurrent
    // generation/summary requests reserve every matching prepared native task, conservatively, once each.
    const live = await tx.doc(LiveDoc, id);
    const ids = [
      live.run?.taskId,
      ...(live.compactions ?? []).map((compaction) => compaction.taskId),
    ].filter((task): task is TaskId => task !== undefined);
    const candidates = await Promise.all(ids.map((taskId) => tx.task(taskId)));
    const tasks = candidates.filter((task) => {
      if (
        !task ||
        (task.kind !== GenerationTask.definition.name &&
          task.kind !== CompactionTask.definition.name)
      )
        return false;
      if (!('checkpoint' in task.state)) return false;
      const state = task.state.checkpoint as { phase?: string; model?: ModelRef };
      return (
        (state.phase === 'request' || state.phase === 'summarize') &&
        !!state.model &&
        sameModel(state.model, model)
      );
    });
    if (!tasks.length) throw new AppError(403, 'native_model_request_missing');
    const current = await executionScope(tx, id, input);
    for (const task of tasks) {
      // A background summary may survive its input. Its first reservation pins authority to that input,
      // even while the same conversation has started a newer generation with another credential.
      if (current.policy.depth === 0) {
        await tx.doc(RootModelGrant, rootModelKey(current.policy.rootId, model), null);
      }
      const seed = copy(current.policy);
      if (seed.depth === 0) seed.models = [copy(model)];
      const binding = await tx.doc(TaskExecutionPolicy, String(task!.id), { policy: seed });
      // A generation retry may re-prepare with a newly authorized root setting under the same TaskId.
      // Updating its model authority does not change its first input scope or charge another round.
      if (binding.policy.depth === 0) binding.policy.models = [copy(model)];
      const policy = copy(binding.policy);
      for (const key of Object.keys(policy.limits) as (keyof PolicyLimits)[])
        policy.limits[key] = Math.min(policy.limits[key], current.policy.limits[key]);
      if (!policy.scope) throw missing();
      const scope = await tx.doc(ExecutionScope, policy.scope, null);
      if (policy.depth === 0 && !scope.models.some((allowed) => sameModel(allowed, model)))
        scope.models.push(copy(model));
      if (
        !policy.models.some((allowed) => sameModel(allowed, model)) ||
        !scope.models.some((allowed) => sameModel(allowed, model)) ||
        (current.policy.modelCeiling &&
          !current.policy.modelCeiling.some((allowed) => sameModel(allowed, model)))
      )
        throw new AppError(403, 'conversation_model_denied');
      await reserveChild(tx, id, policy, scope);
      if (scope.rounds.includes(Number(task!.id))) continue;
      if (scope.rounds.length >= policy.limits.modelRounds)
        throw new Error(
          `Model round limit reached (${policy.limits.modelRounds}). Submit a new request to continue.`,
        );
      scope.rounds.push(Number(task!.id));
    }
  }, context);
}
/** Tools are charged at beforeTool and checked again at execute (including native safe recovery). */
export async function reserveTool(
  pi: Harness,
  id: ConversationId,
  taskId: TaskId,
  name: string,
  args: Record<string, unknown>,
  context: Parameters<Harness['close']>[0],
) {
  const input = await nativeInput(pi, id, context);
  await pi.commit(async (tx) => {
    const task = await tx.task(taskId);
    if (
      !task ||
      task.conversationId !== id ||
      task.kind !== 'pi.tool' ||
      task.state.status === 'terminal'
    )
      throw new AppError(403, 'native_tool_request_missing');
    const current = await executionScope(tx, id, input);
    const inherited = task.owner
      ? (await tx.doc(TaskExecutionPolicy, String(task.owner), null)).policy
      : current.policy;
    const binding = await tx.doc(TaskExecutionPolicy, String(taskId), { policy: copy(inherited) });
    const policy = {
      ...copy(binding.policy),
      tools: current.policy.tools,
      mcp: current.policy.mcp,
      skills: current.policy.skills,
    };
    for (const key of Object.keys(policy.limits) as (keyof PolicyLimits)[])
      policy.limits[key] = Math.min(policy.limits[key], current.policy.limits[key]);
    if (!policy.scope) throw missing();
    const scope = await tx.doc(ExecutionScope, policy.scope, null);
    if (!policy.tools.includes(name)) throw new AppError(403, 'conversation_tool_denied');
    const mcp = policy.toolScopes?.[name]?.mcp;
    if (mcp && !policy.mcp.includes(mcp)) throw new AppError(403, 'conversation_mcp_denied');
    if (name === 'activate_skill' || name === 'read_skill_resource') {
      const skill = typeof args.name === 'string' ? policy.skillNames?.[args.name] : undefined;
      if (!skill || !policy.skills.includes(skill))
        throw new AppError(403, 'conversation_skill_denied');
    }
    await reserveChild(tx, id, policy, scope);
    if (scope.tools.includes(Number(taskId))) return;
    if (scope.tools.length >= policy.limits.toolCalls)
      throw new Error(
        `Tool call limit reached (${policy.limits.toolCalls}). Submit a new request to continue.`,
      );
    scope.tools.push(Number(taskId));
  }, context);
}
