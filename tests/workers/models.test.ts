import {env} from 'cloudflare:test';
import {it,expect} from 'vitest';
import {applicationModels} from '../../src/server/models';
it('registers the installed DeepSeek provider with an explicit catalog model',async()=>{
 const models=applicationModels({...env,MODEL_PROVIDER:'deepseek',MODEL_ID:'deepseek-flash',MODEL_API_KEY:'fixture-only'});
 expect(models.getModel('deepseek','deepseek-flash')).toMatchObject({provider:'deepseek',id:'deepseek-flash',baseUrl:'https://api.deepseek.com',api:'openai-completions'});
 expect(await models.getAuth('deepseek')).toMatchObject({auth:{apiKey:'fixture-only'},source:'application'});
});
it('rejects an absent model instead of silently substituting another DeepSeek model',()=>{
 expect(()=>applicationModels({...env,MODEL_PROVIDER:'deepseek',MODEL_ID:'missing-model',MODEL_API_KEY:'fixture-only'})).toThrow('MODEL_ID is absent');
});
