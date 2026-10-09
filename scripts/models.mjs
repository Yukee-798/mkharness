import {createModels} from '@earendil-works/pi-ai/models';
import {openaiProvider} from '@earendil-works/pi-ai/providers/openai';
import {anthropicProvider} from '@earendil-works/pi-ai/providers/anthropic';
const models=createModels();models.setProvider(openaiProvider());models.setProvider(anthropicProvider());
for(const provider of ['openai','anthropic'])for(const model of models.getModels(provider))console.log(`${provider}\t${model.id}`);
