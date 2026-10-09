import {hook,ToolTask,type EntryRecord,type Extension} from '@earendil-works/pi-durable';
function currentWork(entries:readonly EntryRecord[]){return entries.slice(entries.findLastIndex(e=>e.kind==='pi.user'));}
export function checkRunLimits(entries:readonly EntryRecord[],additionalFailure=0){
 const current=currentWork(entries);const rounds=current.filter(e=>e.kind==='pi.assistant').length;
 const failures=current.flatMap(e=>e.model??[]).filter(m=>m.role==='toolResult'&&['prepare_program','present_openui'].includes(m.toolName)&&m.isError).length;
 if(rounds>=20)throw new Error('Model round limit reached (20). Submit a new request to continue.');
 if(failures+additionalFailure>=3)throw new Error('Program/UI repair limit reached (initial attempt plus two repairs).');
}
export function runLimits(entries:()=>Promise<readonly EntryRecord[]>):Extension{
 return {name:'run-limits',hooks:[hook(ToolTask,{beforeTool:async()=>{const failures=currentWork(await entries()).flatMap(e=>e.model??[]).filter(m=>m.role==='toolResult'&&['prepare_program','present_openui'].includes(m.toolName)&&m.isError).length;return failures>=3?{block:'Program/UI repair limit reached'}:undefined;}})],sections:[{key:'execution-contract',render:()=> 'Synchronous generated computation: export function compute(inputs,data) returning finite JSON. No imports, asynchronous operations, host network/DOM/files/clock/randomness. Maximum code 64 KiB, combined inputs+data and result each 1 MiB, heap 16 MiB and interrupt budget 1024. Complex algorithms are generated for the task; provide meaningful test cases, explain units and assumptions. You have at most 20 model rounds and two repairs after an initial program/UI failure. First prepare_program and read its successful result; then present_openui. Publishing is completed by the backend even when no browser is connected. Native UI actions use local Set/Reset and bound Query("run_program",inputs,fallback); ToAssistant explicitly starts a new user request. Do not inject scripts, HTML code or arbitrary action handlers.'}]};
}

/** A budget exhaustion is a terminal Pi model error, not an exception that Lifecycle retries. */
export function withRunLimits(models:import('@earendil-works/pi-ai/models').Models,entries:()=>Promise<readonly EntryRecord[]>){
 const result=Object.create(models) as import('@earendil-works/pi-ai/models').Models;
 result.streamSimple=(model,context,options)=>{
  const out=new AssistantMessageEventStream();
  void (async()=>{
   try{checkRunLimits(await entries());}catch(error){
    const message:AssistantMessage={role:'assistant',content:[],api:model.api,provider:model.provider,model:model.id,usage:emptyUsage,stopReason:'error',errorMessage:(error as Error).message,timestamp:Date.now()};
    out.push({type:'error',reason:'error',error:message});out.end(message);return;
   }
   const source=models.streamSimple(model,context,options);for await(const event of source)out.push(event);out.end(await source.result());
  })().catch(error=>{const message:AssistantMessage={role:'assistant',content:[],api:model.api,provider:model.provider,model:model.id,usage:emptyUsage,stopReason:'error',errorMessage:'Model dispatch failed',timestamp:Date.now()};out.push({type:'error',reason:'error',error:message});out.end(message);});
  return out;
 };return result;
}
import {AssistantMessageEventStream} from '@earendil-works/pi-ai/utils/event-stream';
import type {AssistantMessage} from '@earendil-works/pi-ai';
const emptyUsage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
