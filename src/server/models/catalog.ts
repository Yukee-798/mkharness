import {
  createModels,
  getSupportedThinkingLevels,
  clampThinkingLevel,
  type Models,
} from '@earendil-works/pi-ai/models';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { AppError } from '../../shared/contracts';
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import {
  thinkingLevels,
  type ModelCatalog,
  type ModelSelection,
} from '../../shared/model-selection';
export const modelProviders = [
  { id: 'openai', name: 'OpenAI', factory: openaiProvider, defaultModel: 'gpt-5-mini' },
  {
    id: 'anthropic',
    name: 'Anthropic',
    factory: anthropicProvider,
    defaultModel: 'claude-sonnet-4-5',
  },
  { id: 'deepseek', name: 'DeepSeek', factory: deepseekProvider, defaultModel: 'deepseek-flash' },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    factory: openrouterProvider,
    defaultModel: 'openrouter/free',
  },
] as const;
export function registeredProvider(id: string) {
  const provider = modelProviders.find((p) => p.id === id);
  if (!provider) throw new AppError(400, 'unsupported_provider', '此供应商尚未注册');
  return provider;
}
type ModelEnvironment = {
  MODEL_PROVIDER?: string;
  MODEL_ID?: string;
  MODEL_IDS?: string;
  MODEL_THINKING_LEVEL?: string;
};
export function applicationModelCatalog(env: ModelEnvironment, models: Models): ModelCatalog {
  const provider = env.MODEL_PROVIDER?.trim() || 'deepseek';
  const modelId =
    env.MODEL_ID?.trim() || modelProviders.find((p) => p.id === provider)?.defaultModel || '';
  const initial = models.getModel(provider, modelId);
  if (!initial)
    throw new AppError(503, 'unknown_model', 'MODEL_ID is absent from the installed Pi catalog');
  const restricted = env.MODEL_IDS?.trim()
    ? new Set(
        env.MODEL_IDS.split(',')
          .map((id) => id.trim())
          .filter(Boolean),
      )
    : undefined;
  if (restricted && !restricted.has(modelId))
    throw new AppError(503, 'invalid_model_catalog', 'MODEL_IDS must include MODEL_ID');
  if (restricted && [...restricted].some((id) => !models.getModel(provider, id)))
    throw new AppError(503, 'invalid_model_catalog', 'MODEL_IDS contains an unknown model');
  return {
    models: models
      .getProviders()
      .flatMap((p) => models.getModels(p.id))
      .filter((m) => m.provider !== provider || !restricted || restricted.has(m.id))
      .map((m) => ({
        id: m.id,
        name: m.name,
        provider: m.provider,
        thinkingLevels: getSupportedThinkingLevels(m),
      })),
    defaultSelection: {
      provider,
      modelId,
      thinkingLevel: clampThinkingLevel(initial, applicationThinkingLevel(env)),
    },
  };
}
export function validateModelSelection(
  env: ModelEnvironment,
  models: Models,
  selection?: ModelSelection,
): ModelSelection {
  const catalog = applicationModelCatalog(env, models),
    chosen = selection ?? catalog.defaultSelection;
  const model = catalog.models.find(
    (m) => m.id === chosen.modelId && m.provider === chosen.provider,
  );
  if (!model) throw new AppError(400, 'model_not_allowed', '所选模型不可用，请重新选择');
  if (!model.thinkingLevels.includes(chosen.thinkingLevel))
    throw new AppError(400, 'thinking_level_not_supported', '该模型不支持所选思考强度');
  return chosen;
}
export function applicationThinkingLevel(env: {
  MODEL_THINKING_LEVEL?: string;
}): ModelThinkingLevel {
  const level = env.MODEL_THINKING_LEVEL ?? 'low';
  if (!thinkingLevels.includes(level as ModelThinkingLevel))
    throw new AppError(503, 'invalid_thinking_level', 'Invalid MODEL_THINKING_LEVEL');
  return level as ModelThinkingLevel;
}
/** Catalog registration is independent of credentials. Only immutable credential aliases may authenticate. */
export function applicationModels(env: ModelEnvironment): Models {
  const models = createModels({
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  for (const definition of modelProviders)
    models.setProvider({
      ...definition.factory(),
      auth: {
        apiKey: {
          name: 'Step-bound credential',
          resolve: async () => {
            throw new AppError(503, 'execution_binding_required', '模型调用缺少步骤凭据绑定');
          },
        },
      },
    });
  applicationModelCatalog(env, models);
  return models;
}

/** Public choices are explicit configuration, not the entire installed SDK catalog. */
export function configuredModelCatalog(
  env: ModelEnvironment,
  models: Models,
  preferences: readonly { provider: string; modelId: string }[] = [],
): ModelCatalog {
  const available = applicationModelCatalog(env, models);
  const configured = preferences.filter((preference) =>
    available.models.some(
      (model) => model.provider === preference.provider && model.id === preference.modelId,
    ),
  );
  const preferred = configured[0];
  const selection = preferred
    ? { ...available.defaultSelection, provider: preferred.provider, modelId: preferred.modelId }
    : available.defaultSelection;
  const ids = env.MODEL_IDS?.split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const choices = available.models.filter(
    (model) =>
      configured.some((p) => p.provider === model.provider && p.modelId === model.id) ||
      (model.provider === available.defaultSelection.provider &&
        (ids?.length
          ? ids.includes(model.id)
          : model.id ===
            (selection.provider === available.defaultSelection.provider
              ? selection.modelId
              : available.defaultSelection.modelId))),
  );
  const selected = models.getModel(selection.provider, selection.modelId)!;
  return {
    models: choices,
    defaultSelection: {
      ...selection,
      thinkingLevel: clampThinkingLevel(selected, selection.thinkingLevel),
    },
  };
}
