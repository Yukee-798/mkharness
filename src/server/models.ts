import {
  createModels,
  getSupportedThinkingLevels,
  clampThinkingLevel,
  type Models,
} from '@earendil-works/pi-ai/models';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { AppError } from '../shared/contracts';
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import { thinkingLevels, type ModelCatalog, type ModelSelection } from '../shared/model-selection';
type ModelEnvironment = {
  MODEL_PROVIDER: string;
  MODEL_ID: string;
  MODEL_IDS?: string;
  MODEL_THINKING_LEVEL?: string;
};
export function applicationModelCatalog(env: ModelEnvironment, models: Models): ModelCatalog {
  const available = models.getModels(env.MODEL_PROVIDER);
  const ids = env.MODEL_IDS?.trim()
    ? env.MODEL_IDS.split(',')
        .map((id) => id.trim())
        .filter(Boolean)
    : available.map((m) => m.id);
  if (!ids.includes(env.MODEL_ID))
    throw new AppError(503, 'invalid_model_catalog', 'MODEL_IDS must include MODEL_ID');
  const options = [...new Set(ids)].map((id) => {
    const model = available.find((m) => m.id === id);
    if (!model)
      throw new AppError(503, 'invalid_model_catalog', 'MODEL_IDS contains an unknown model');
    return {
      id,
      name: model.name,
      provider: model.provider,
      thinkingLevels: getSupportedThinkingLevels(model),
    };
  });
  const initial = models.getModel(env.MODEL_PROVIDER, env.MODEL_ID)!;
  return {
    models: options,
    defaultSelection: {
      modelId: env.MODEL_ID,
      thinkingLevel: clampThinkingLevel(initial, applicationThinkingLevel(env)),
    },
  };
}
export function validateModelSelection(
  env: ModelEnvironment,
  models: Models,
  selection?: ModelSelection,
): ModelSelection {
  const catalog = applicationModelCatalog(env, models);
  const chosen = selection ?? catalog.defaultSelection;
  const model = catalog.models.find((m) => m.id === chosen.modelId);
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
export function applicationModels(env: {
  MODEL_PROVIDER: string;
  MODEL_ID: string;
  MODEL_API_KEY?: string;
}): Models {
  if (!env.MODEL_PROVIDER || !env.MODEL_ID || !env.MODEL_API_KEY)
    throw new AppError(
      503,
      'model_not_configured',
      'Configure MODEL_PROVIDER, MODEL_ID and MODEL_API_KEY',
    );
  const provider =
    env.MODEL_PROVIDER === 'openai'
      ? openaiProvider()
      : env.MODEL_PROVIDER === 'anthropic'
        ? anthropicProvider()
        : env.MODEL_PROVIDER === 'deepseek'
          ? deepseekProvider()
          : undefined;
  if (!provider)
    throw new AppError(
      503,
      'unsupported_provider',
      'Register the selected Pi provider in src/server/models.ts',
    );
  const models = createModels({
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  models.setProvider({
    ...provider,
    auth: {
      apiKey: {
        name: 'Application key',
        resolve: async () => ({ auth: { apiKey: env.MODEL_API_KEY }, source: 'application' }),
      },
    },
  });
  if (!models.getModel(env.MODEL_PROVIDER, env.MODEL_ID))
    throw new AppError(503, 'unknown_model', 'MODEL_ID is absent from the installed Pi catalog');
  return models;
}
