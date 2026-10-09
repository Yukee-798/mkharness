import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {Renderer,type ActionEvent} from '@openuidev/react-lang';
import {library,PanelContext,type PanelGuard} from '../shared/catalog';
import type {Program,Json} from '../shared/compute';
import {finiteJson,jsonText} from '../shared/compute';
import type {RawState,RunCommand} from '../shared/contracts';
import {computeProgram} from './compute';
import {request} from './api';
import {createDraftSaver,type SaveStatus} from './draft';
import {Button} from './ui/button';
export type PanelBundle={panelRef:string;ui:string;program:Program|null;state?:RawState;revision:number};
export function Panel({conversationId,panelRef,preview,submit}:{conversationId:string;panelRef?:string;preview?:string;submit:(text:string,source?:RunCommand['source'])=>Promise<void>}){
 const [bundle,setBundle]=useState<PanelBundle>(),[error,setError]=useState(''),[status,setStatus]=useState<SaveStatus>('saved'),[guardTick,setGuardTick]=useState(0);
 const state=useRef<RawState>({}),epoch=useRef(0),userEvent=useRef(false);
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
  if(!bundle?.program)return undefined;let live=true,failed=false;const active=new Set<symbol>(),provenance=new WeakMap<object,string>();
  guard.isCurrent=(frame:unknown)=>{if(!frame||typeof frame!=='object')return false;const f=frame as {result:unknown;inputs:unknown};try{return !!f.result&&typeof f.result==='object'&&provenance.get(f.result)===jsonText(f.inputs);}catch{return false;}};
  const notify=()=>{if(live){guard.ready=active.size===0&&!failed;setGuardTick(n=>n+1);}};
  const provider={run_program:async(inputs:Record<string,unknown>)=>{
   finiteJson(inputs);const token=Symbol(),startedEpoch=guard.epoch;active.add(token);failed=false;guard.ready=false;
   try{const result=await computeProgram(bundle.program!,inputs as Json);
    if(!live||startedEpoch!==guard.epoch)throw new Error('Stale computation discarded');
    if(!result.ok){failed=true;setError(result.error.message);throw new Error(result.error.message);}
    if(result.value&&typeof result.value==='object')provenance.set(result.value,jsonText(inputs));
    return result.value;
   }finally{active.delete(token);notify();}
  }};
  return {provider,ready:()=>active.size===0&&!failed,resetError:()=>{failed=false;},activate:()=>{live=true;},dispose:()=>{live=false;guard.ready=false;}};
 },[bundle,guard]);
 useEffect(()=>{tools?.activate();return()=>tools?.dispose();},[tools]);
 const change=useCallback((raw:Record<string,unknown>)=>{try{finiteJson(raw);if(userEvent.current&&jsonText(raw)!==jsonText(state.current)){userEvent.current=false;guard.epoch=++epoch.current;guard.halted=false;tools?.resetError();}state.current=raw as RawState;guard.ready=!bundle?.program||!!tools?.ready();setGuardTick(n=>n+1);saver?.update(state.current);}catch{setError('Input state cannot be saved as finite JSON');}},[saver,guard,bundle,tools]);
 const act=useCallback((event:ActionEvent)=>{
  if(!bundle)return;
  if(event.type!=='continue_conversation'){setError('This action is not available in this application');return;}
  void submit(event.humanFriendlyMessage||'Analyze the current inputs',{panelRef:bundle.panelRef,action:'continue_analysis',state:structuredClone({...state.current,...event.formState})}).catch(e=>setError(e.message));
 },[bundle,submit]);
 const context=useMemo(()=>Object.create(guard) as PanelGuard,[guard,guardTick]);
 // Native state updates are synchronous; only a changed input starts a new chain.
 const edit=()=>{userEvent.current=true;setTimeout(()=>{userEvent.current=false;},0);};
 return <section className="generated-panel" aria-label="Interactive answer" onChangeCapture={edit} onClickCapture={edit} onKeyDownCapture={edit}>
  <div inert={!bundle || undefined}><PanelContext value={context}><Renderer response={bundle?.ui??preview??null} library={library} isStreaming={!bundle} initialState={bundle?.state} onStateUpdate={bundle?change:undefined} onAction={bundle?act:undefined} toolProvider={tools?.provider} publishObservability={false}/></PanelContext></div>
  {panelRef&&!bundle&&!error&&<p role="status">正在恢复面板…</p>}
  {bundle?.program&&<p className="muted">参数调整在本地重算；计算出错时，图表可能保留上次结果。单位、数据与假设以面板说明为准。</p>}
  {bundle&&<p className="save-status" role="status">{{saved:'已保存',saving:'保存中…',unsaved:'等待保存…',error:'保存失败，草稿仍在当前页面',conflict:'另一页面已更新；当前草稿已保留，请重新加载确认'}[status]}</p>}
  {status==='error'&&<Button onClick={()=>saver?.retry()}>重试保存</Button>}
  {error&&<p role="alert">{error}</p>}
 </section>;
}
