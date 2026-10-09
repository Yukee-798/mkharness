import {createModels} from '@earendil-works/pi-ai/models';
import type {Model,AssistantMessage,TranscriptContext,SimpleStreamOptions} from '@earendil-works/pi-ai';
import {AssistantMessageEventStream} from '@earendil-works/pi-ai/utils/event-stream';
export const model:Model<'openai-responses'>={provider:'fixture',id:'fixture',name:'Test only',api:'openai-responses',baseUrl:'https://fixture.invalid',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:100000,maxTokens:4000};
export const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
export function fixtureModels(){
 const models=createModels();
 const stream=(_model:Model<any>,context:TranscriptContext,_options?:unknown)=>{
   const events=new AssistantMessageEventStream();
   const lastUser=context.messages.findLast(m=>m.role==='user');
   const text=typeof lastUser?.content==='string'?lastUser.content:JSON.stringify(lastUser?.content);
   const last=context.messages.at(-1);
   const tool=text?.includes('ignores_cancel')&&last?.role==='user';
   let content:AssistantMessage['content']|undefined;
   if(text?.includes('panel')){
    if(last?.role==='user')content=[{type:'toolCall',id:'same-call',name:'prepare_program',arguments:{code:'export function compute(i,d){return {double:Number(i.cost)*d.factor}}',initialInputs:{cost:'100'},data:{factor:2},cases:[{inputs:{cost:'100'},expected:{double:200}}]}}];
    else if(last?.role==='toolResult' && last.toolName==='prepare_program')content=[{type:'toolCall',id:'same-call',name:'present_openui',arguments:{programRef:(last.details as any)?.ref ?? 'missing',ui:'$cost = \"100\"\nresult = Query(\"run_program\",{cost:$cost},{double:0})\nroot = Stack([Input(\"cost\",\"Cost\",\"number\",null,$cost),Text(\"text\",\"Interactive example\")])'}}];
   }
   const message:AssistantMessage={role:'assistant',content:content??(tool?[{type:'toolCall',id:'same-call',name:'ignores_cancel',arguments:{}}]:[{type:'text',text:'Answer: '+text}]),api:'openai-responses',provider:'fixture',model:'fixture',usage,stopReason:(content||tool)?'toolUse':'stop',timestamp:Date.now()};
   events.push({type:'start',partial:{...message,content:[]}});
   setTimeout(()=>{events.push({type:'done',reason:message.stopReason==='toolUse'?'toolUse':'stop',message});events.end(message);},text?.includes('slow')?1000:30);
   return events;
 };
 models.setProvider({id:'fixture',name:'Fixture',auth:{apiKey:{name:'Fixture',resolve:async()=>({auth:{apiKey:'fixture'},source:'fixture'})}},getModels:()=>[model],stream,streamSimple:stream});
 return models;
}
