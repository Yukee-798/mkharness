import {
  createModels,
  type Models,
  type MutableModels,
  type Provider,
} from '@earendil-works/pi-ai/models';
import { imageModelError } from '../../shared/images';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { AppError, type StoredRequest } from '../../shared/contracts';
import { modelEndpointFetch } from './endpoint';
import type { ModelCredentials } from './credentials';
import {
  AgentDoc,
  GenerationTask,
  CompactionTask,
  type Session,
  type ModelRef,
  type GenerationCheckpoint,
  type CompactionCheckpoint,
  type Cursor,
  type ConversationId,
} from '@earendil-works/pi-durable';
export type CredentialAccess = Pick<ModelCredentials, 'select' | 'resolve'> &
  Partial<Pick<ModelCredentials, 'configuredModels'>>;
const freeModelUnavailable =
  '免费模型额度已用完或服务暂时限流，请稍后重试，或配置个人 API Key。不会自动切换至付费模型。';
const freeModelServiceUnavailable =
  '免费模型服务暂时不可用，请稍后重试，或配置个人模型。不会自动切换至付费模型。';
const boundProviders = new WeakMap<MutableModels, Map<string, string>>();
export function executionModels(base: Models) {
  const models = createModels({
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  for (const provider of base.getProviders()) models.setProvider(provider);
  const providers = new Map<string, string>();
  boundProviders.set(models, providers);
  const getAuth = models.getAuth.bind(models);
  models.getAuth = async (provider, options) => {
    try {
      return await (typeof provider === 'string'
        ? getAuth(provider, options)
        : getAuth(provider, options));
    } catch (error) {
      const cause = error instanceof Error ? error.cause : undefined;
      if (cause instanceof AppError) throw cause;
      throw new AppError(503, 'model_auth_failed', '模型凭据解析失败，请检查配置');
    }
  };
  const simple = models.streamSimple.bind(models),
    stream = models.stream.bind(models);
  const relay = (source: AssistantMessageEventStream, provider: string) => {
    const out = new AssistantMessageEventStream();
    void (async () => {
      for await (const event of source)
        out.push(
          event.type === 'error'
            ? { ...event, error: safeError({ ...event.error, provider }, true) }
            : event,
        );
      const result = await source.result();
      out.end(result.stopReason === 'error' ? safeError({ ...result, provider }, true) : result);
    })();
    return out;
  };
  const imagesUnsupported = (
    model: Parameters<Models['streamSimple']>[0],
    context: Parameters<Models['streamSimple']>[1],
  ) => {
    const user = context.messages.findLast((message) => message.role === 'user');
    return (
      !model.input.includes('image') &&
      Array.isArray(user?.content) &&
      user.content.some((part) => part.type === 'image')
    );
  };
  const imageError = (model: Parameters<Models['streamSimple']>[0]) => {
    const result: AssistantMessage = {
      role: 'assistant',
      content: [],
      api: model.api,
      provider: providers.get(model.provider) ?? model.provider,
      model: model.id,
      usage: emptyUsage,
      stopReason: 'error',
      errorMessage: imageModelError,
      timestamp: Date.now(),
    };
    const out = new AssistantMessageEventStream();
    out.push({ type: 'error', reason: 'error', error: result });
    out.end(result);
    return out;
  };
  // A queued input can inherit a newer step configuration. Check at the public
  // model boundary as well as admission so Pi never silently drops its images.
  models.streamSimple = (model, context, options) =>
    imagesUnsupported(model, context)
      ? imageError(model)
      : providers.has(model.provider)
        ? relay(simple(model, context, options), providers.get(model.provider)!)
        : simple(model, context, options);
  models.stream = (model, context, options) =>
    imagesUnsupported(model, context)
      ? imageError(model)
      : providers.has(model.provider)
        ? relay(stream(model, context, options), providers.get(model.provider)!)
        : stream(model, context, options);
  return models;
}
export async function executionProviderId(execution: StoredRequest['execution']) {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify([execution.provider, execution.credentialRef])),
    ),
  );
  return 'mkharness-bound-' + Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Rebuild aliases for the current native configuration and live pinned requests only.
 * The single Harness is paused while this runs; credentials are resolved lazily at
 * the provider boundary, so completed history does not depend on an old secret.
 */
export async function restoreExecutionModels(
  session: Session,
  models: MutableModels,
  lookup: (
    refs: readonly ModelRef[],
  ) => Promise<readonly { execution: StoredRequest['execution'] }[]>,
  credentials: () => Promise<CredentialAccess>,
  context: Parameters<Session['close']>[0],
) {
  const refs = new Map<string, ModelRef>();
  const refKey = (ref: ModelRef) => JSON.stringify([ref.provider, ref.modelId]);
  const add = (ref?: ModelRef) => {
    if (ref) refs.set(refKey(ref), ref);
  };
  const conversationIds = await session.commit(async (tx) => {
    const ids: ConversationId[] = [];
    let conversationCursor: Cursor | undefined;
    do {
      const page = await tx.scanConversations({}, 100, conversationCursor);
      ids.push(...page.items.map((conversation) => conversation.id));
      conversationCursor = page.next;
    } while (conversationCursor);
    for (const kind of [GenerationTask.definition.name, CompactionTask.definition.name]) {
      for (const status of ['pending', 'running', 'waiting'] as const) {
        let cursor: Cursor | undefined;
        do {
          const page = await tx.scanTasks({ kind, status }, 100, cursor);
          for (const task of page.items) {
            const checkpoint = task.state.checkpoint as
              GenerationCheckpoint | CompactionCheckpoint | undefined;
            if (checkpoint && 'model' in checkpoint) add(checkpoint.model);
          }
          cursor = page.next;
        } while (cursor);
      }
    }
    return ids;
  }, context);
  for (const conversationId of conversationIds)
    add((await session.snapshot(AgentDoc, conversationId, context))?.model);
  const executions = new Map<string, StoredRequest['execution']>();
  for (const { execution } of await lookup([...refs.values()]))
    executions.set(
      JSON.stringify([await executionProviderId(execution), execution.modelId]),
      execution,
    );
  for (const ref of refs.values()) {
    const execution = executions.get(refKey(ref));
    if (execution) await bindStoredExecution(models, execution, credentials);
    // A missing alias stays unavailable. Pi settles only the affected native work
    // as no_model; reading history, Stop and deleting the chat remain available.
  }
}
/** Stored work has already passed admission. Let Pi settle an unavailable model
 * without making the entire conversation (including Stop and history) unavailable. */
export async function bindStoredExecution(
  models: MutableModels,
  execution: StoredRequest['execution'],
  credentials: () => Promise<CredentialAccess>,
) {
  return models.getModel(execution.provider, execution.modelId)
    ? bindExecution(models, execution, credentials)
    : executionProviderId(execution);
}
/** Native model identity carries immutable credential ownership through native prepare and compaction checkpoints. */
export async function bindExecution(
  models: MutableModels,
  execution: StoredRequest['execution'],
  credentials: () => Promise<CredentialAccess>,
) {
  const id = await executionProviderId(execution);
  // Each requested model must still exist, even when this credential alias is already installed.
  const base = models.getProvider(execution.provider);
  if (!base || !models.getModel(execution.provider, execution.modelId))
    throw new AppError(503, 'execution_model_unavailable', '原请求的模型当前不可用');
  if (models.getProvider(id)) return id;
  const relay = (
    sourceFactory: () => AssistantMessageEventStream,
    model: Parameters<Provider['streamSimple']>[0],
  ) => {
    // Restore the supplier identity only at its protocol boundary. Model, API, window and effort are unchanged.
    const out = new AssistantMessageEventStream();
    void (async () => {
      try {
        const source = sourceFactory();
        for await (const event of source) {
          if (event.type === 'error') out.push({ ...event, error: safeError(event.error) });
          else out.push(event);
        }
        const result = await source.result();
        out.end(result.stopReason === 'error' ? safeError(result) : result);
      } catch {
        const error = safeError({
          role: 'assistant',
          content: [],
          api: model.api,
          provider: base.id,
          model: model.id,
          usage: emptyUsage,
          stopReason: 'error',
          timestamp: Date.now(),
        });
        out.push({ type: 'error', reason: 'error', error });
        out.end(error);
      }
    })();
    return out;
  };
  const requestOptions = <T extends import('@earendil-works/pi-ai').StreamOptions>(
    model: { id: string; baseUrl: string },
    options: T | undefined,
  ): T | undefined => {
    // Bundled catalog destinations remain native; only user overrides need the egress guard.
    // This avoids two extra DNS subrequests per normal model call.
    const native = model.baseUrl === models.getModel(base.id, model.id)?.baseUrl;
    const result = {
      ...options,
      ...(native ? {} : { fetch: modelEndpointFetch(model.baseUrl, options?.fetch) }),
    };
    if (base.id === 'openrouter' && (model.id === 'openrouter/free' || model.id.endsWith(':free')))
      return { ...result, maxRetries: 0 } as T;
    return native ? options : (result as T);
  };
  boundProviders.get(models)?.set(id, base.id);
  models.setProvider({
    ...base,
    id,
    getModels: () => base.getModels().map((m) => ({ ...m, provider: id })),
    getAllModels: undefined,
    auth: {
      apiKey: {
        name: 'Immutable step credential',
        resolve: async () => ({
          auth: await (await credentials()).resolve(execution.provider, execution.credentialRef),
          source: 'step-bound',
        }),
      },
    },
    stream: (model, context, options) =>
      relay(
        () => base.stream({ ...model, provider: base.id }, context, requestOptions(model, options)),
        model,
      ),
    streamSimple: (model, context, options) =>
      relay(
        () =>
          base.streamSimple(
            { ...model, provider: base.id },
            context,
            requestOptions(model, options),
          ),
        model,
      ),
  });
  return id;
}
function safeError(message: AssistantMessage, trustedCredential = false): AssistantMessage {
  const text = message.errorMessage ?? '';
  const credentialMessages = [
    '原请求的个人凭据已撤销或过期，请发起新请求',
    '原请求的部署凭据当前不可用',
    '原请求的部署凭据已更改，请发起新请求',
    '个人凭据无法解密，请检查部署主密钥并重新配置',
    '部署尚未配置凭据加密密钥',
    freeModelUnavailable,
    freeModelServiceUnavailable,
  ];
  const errorMessage =
    trustedCredential && credentialMessages.includes(text)
      ? text
      : message.provider === 'openrouter' &&
          (message.model === 'openrouter/free' || message.model.endsWith(':free')) &&
          /\b(?:402|429)\b|rate.?limit|insufficient.?credit|quota.?exceed/i.test(text)
        ? freeModelUnavailable
        : /429|rate.?limit/i.test(text)
          ? '429 rate limit: 模型服务暂时限流，请稍后重试'
          : /maximum context length|context.?window|context.?length/i.test(text)
            ? 'maximum context length exceeded'
            : message.provider === 'openrouter' &&
                (message.model === 'openrouter/free' || message.model.endsWith(':free'))
              ? freeModelServiceUnavailable
              : '模型服务请求失败，请检查 Base URL、API Key 与服务状态后发起新请求。';
  return {
    ...message,
    content: [],
    errorMessage,
  };
}
const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function publicModelProvider(models: Models, provider: string) {
  return boundProviders.get(models as MutableModels)?.get(provider) ?? provider;
}
