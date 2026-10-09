import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {Renderer,type ActionEvent} from '@openuidev/react-lang';
import {library,PanelContext,type PanelGuard} from '../shared/catalog';
import type {Program,Json} from '../shared/compute';
import {finiteJson} from '../shared/compute';
import type {RawState,RunCommand} from '../shared/contracts';
import {computeProgram} from './compute';
import {request} from './api';
import {createDraftSaver,type SaveStatus} from './draft';
export type PanelBundle={panelRef:string;ui:string;program:Program|null;state?:RawState;revision:number};
export function Panel({conversationId,panelRef,preview,submit}:{conversationId:string;panelRef?:string;preview?:string;submit:(text:string,source?:RunCommand['source'])=>Promise<void>}){
 const [bundle,setBundle]=useState<PanelBundle>(),[error,setError]=useState(''),[status,setStatus]=useState<SaveStatus>('saved');
 const state=useRef<RawState>({}),epoch=useRef(0);
 useEffect(()=>{
  if(!panelRef)return;const controller=new AbortController();
  void request<PanelBundle>(`/conversations/${conversationId}/panels/${encodeURIComponent(panelRef)}`,{signal:controller.signal}).then(value=>{state.current=value.state??{};setBundle(value);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});
  return()=>controller.abort();
 },[conversationId,panelRef]);
 const saver=useMemo(()=>bundle?createDraftSaver(async(raw,revision)=>{
  const result=await request<{revision:number}>(`/conversations/${conversationId}/panels/${encodeURIComponent(bundle.panelRef)}/state`,{method:'PATCH',body:JSON.stringify({state:raw,expectedRevision:revision})});return result.revision;
 },bundle.revision,setStatus):undefined,[bundle,conversationId]);
 useEffect(()=>()=>saver?.dispose(),[saver]);
 const guard=useMemo<PanelGuard>(()=>({epoch:0,ready:!bundle?.program,halted:false,report:setError}),[bundle]);
 const tools=useMemo(()=>{
  if(!bundle?.program)return undefined;let latest=0,live=true;
  const provider={run_program:async(inputs:Record<string,unknown>)=>{
   finiteJson(inputs);const version=++latest,startedEpoch=guard.epoch;guard.ready=false;
   const result=await computeProgram(bundle.program!,inputs as Json);
   if(!live||version!==latest||startedEpoch!==guard.epoch)throw new Error('Stale computation discarded');
   if(!result.ok){setError(result.error.message);throw new Error(result.error.message);}
   guard.ready=true;return result.value;
  }};
  return {provider,dispose:()=>{live=false;latest++;guard.ready=false;}};
 },[bundle,guard]);
 useEffect(()=>()=>tools?.dispose(),[tools]);
 const change=useCallback((raw:Record<string,unknown>)=>{try{finiteJson(raw);state.current=raw as RawState;guard.ready=!bundle?.program;saver?.update(state.current);}catch{setError('Input state cannot be saved as finite JSON');}},[saver,guard,bundle]);
 const act=useCallback((event:ActionEvent)=>{
  if(!bundle)return;
  if(event.type!=='continue_conversation'){setError('This action is not available in this application');return;}
  void submit(event.humanFriendlyMessage||'Analyze the current inputs',{panelRef:bundle.panelRef,action:'continue_analysis',state:structuredClone({...state.current,...event.formState})}).catch(e=>setError(e.message));
 },[bundle,submit]);
 const edit=()=>{guard.epoch=++epoch.current;guard.halted=false;};
 return <section className="generated-panel" aria-label="Interactive answer" onInputCapture={edit} onClickCapture={edit} onKeyDownCapture={edit}>
  <div inert={!bundle || undefined}><PanelContext value={guard}><Renderer response={bundle?.ui??preview??null} library={library} isStreaming={!bundle} initialState={bundle?.state} onStateUpdate={bundle?change:undefined} onAction={bundle?act:undefined} toolProvider={tools?.provider} publishObservability={false}/></PanelContext></div>
  {panelRef&&!bundle&&!error&&<p role="status">正在恢复面板…</p>}
  {bundle&&<p className="save-status" role="status">{{saved:'已保存',saving:'保存中…',unsaved:'等待保存…',error:'保存失败，草稿仍在当前页面',conflict:'另一页面已更新；当前草稿已保留，请重新加载确认'}[status]}</p>}
  {status==='error'&&<button onClick={()=>saver?.retry()}>重试保存</button>}
  {error&&<p role="alert">{error}</p>}
 </section>;
}
