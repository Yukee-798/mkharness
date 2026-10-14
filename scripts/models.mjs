import { createModels } from '@earendil-works/pi-ai/models';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
const models = createModels();
models.setProvider(openaiProvider());
models.setProvider(anthropicProvider());
models.setProvider(deepseekProvider());
models.setProvider(openrouterProvider());
for (const provider of ['openai', 'anthropic', 'deepseek', 'openrouter'])
  for (const model of models.getModels(provider)) console.log(`${provider}\t${model.id}`);
