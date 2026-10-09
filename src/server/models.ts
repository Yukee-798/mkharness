import {createModels,type Models} from '@earendil-works/pi-ai/models';
import {openaiProvider} from '@earendil-works/pi-ai/providers/openai';
import {anthropicProvider} from '@earendil-works/pi-ai/providers/anthropic';
import {deepseekProvider} from '@earendil-works/pi-ai/providers/deepseek';
import {AppError} from '../shared/contracts';
export function applicationModels(env:{MODEL_PROVIDER:string;MODEL_ID:string;MODEL_API_KEY?:string}):Models {
  if(!env.MODEL_PROVIDER || !env.MODEL_ID || !env.MODEL_API_KEY)throw new AppError(503,'model_not_configured','Configure MODEL_PROVIDER, MODEL_ID and MODEL_API_KEY');
  const provider=env.MODEL_PROVIDER==='openai'?openaiProvider():env.MODEL_PROVIDER==='anthropic'?anthropicProvider():env.MODEL_PROVIDER==='deepseek'?deepseekProvider():undefined;
  if(!provider)throw new AppError(503,'unsupported_provider','Register the selected Pi provider in src/server/models.ts');
  const models=createModels({authContext:{env:async()=>undefined,fileExists:async()=>false}});
  models.setProvider({...provider,auth:{apiKey:{name:'Application key',resolve:async()=>({auth:{apiKey:env.MODEL_API_KEY},source:'application'})}}});
  if(!models.getModel(env.MODEL_PROVIDER,env.MODEL_ID))throw new AppError(503,'unknown_model','MODEL_ID is absent from the installed Pi catalog');
  return models;
}
