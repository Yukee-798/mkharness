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
   if(text?.includes('reordered_case')&&last?.role==='user')content=[{type:'toolCall',id:'same-call',name:'prepare_program',arguments:{code:'export function compute(){return {a:1,b:2}}',initialInputs:{},data:null,cases:[{inputs:{},expected:{b:2,a:1}}]}}];
   if(text?.includes('panel')){
    if(last?.role==='user')content=[{type:'toolCall',id:'same-call',name:'prepare_program',arguments:{code:'export function compute(i,d){return {double:Number(i.cost)*d.factor}}',initialInputs:{cost:'100'},data:{factor:2},cases:[{inputs:{cost:'100'},expected:{double:200}}]}}];
    else if(last?.role==='toolResult' && last.toolName==='prepare_program')content=[{type:'toolCall',id:'same-call',name:'present_openui',arguments:{programRef:(last.details as any)?.ref ?? 'missing',ui:'$cost = \"100\"\nresult = Query(\"run_program\",{cost:$cost},{double:0})\nroot = Stack([Input(\"cost\",\"Cost\",\"number\",null,$cost),Text(\"text\",\"Interactive example\")])'}}];
   }
   if(text?.includes('invalid_program')||text?.includes('loop_model'))content=[{type:'toolCall',id:'same-call',name:'prepare_program',arguments:{code:text.includes('invalid_program')?'export const bad=1':'export function compute(){return 0}',initialInputs:{},data:null,cases:[{inputs:{},expected:0}]}}];
   if(text?.includes('multiple_text_blocks'))content=[{type:'text',text:'First section'},{type:'text',text:'Second section'}];
   if(context.messages.some(m=>m.role==='system'&&typeof m.content==='string'&&m.content.toLowerCase().includes('summariz')))content=[{type:'text',text:'Summary of earlier work and its published panel.'}];
   const message:AssistantMessage={role:'assistant',content:content??(tool?[{type:'toolCall',id:'same-call',name:'ignores_cancel',arguments:{}}]:[{type:'text',text:text?.includes('long_summary')?'Context '+ 'x'.repeat(120000):'Answer: '+text}]),api:'openai-responses',provider:'fixture',model:'fixture',usage:text?.includes('long_summary')?{...usage,output:30000,totalTokens:30000}:usage,stopReason:(content?.some(b=>b.type==='toolCall')||tool)?'toolUse':'stop',timestamp:Date.now()};
   events.push({type:'start',partial:{...message,content:[]}});
   setTimeout(()=>{events.push({type:'done',reason:message.stopReason==='toolUse'?'toolUse':'stop',message});events.end(message);},text?.includes('slow')?1000:30);
   return events;
 };
 models.setProvider({id:'fixture',name:'Fixture',auth:{apiKey:{name:'Fixture',resolve:async()=>({auth:{apiKey:'fixture'},source:'fixture'})}},getModels:()=>[model],stream,streamSimple:stream});
 return models;
}
