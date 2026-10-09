import {useEffect,useMemo,useState,useRef,createContext,useContext} from 'react';
import {AssistantRuntimeProvider,ThreadPrimitive,MessagePrimitive,fromThreadMessageLike,type ThreadHistoryAdapter,type ToolCallMessagePartProps} from '@assistant-ui/react';
import {useAgUiRuntime,fromAgUiMessages} from '@assistant-ui/react-ag-ui';
import type {EntryRecord} from '@earendil-works/pi-durable';
import {toMessages} from '../shared/stream';
import type {RunCommand} from '../shared/contracts';
import {AttachAgent,partialUI,StreamReplaced} from './transport';
import {Panel} from './Panel';
import {request} from './api';
import {createSubmitter} from './submission';
import {Button} from './ui/button';
export type Snapshot={entries:EntryRecord[];cursor?:unknown;pending:{operationId:string;status:'running'|'queued'}[];stopping:boolean};
export async function loadSnapshot(id:string,signal?:AbortSignal){
 const first=await request<Snapshot>(`/conversations/${id}/snapshot`,{signal});let cursor=first.cursor;
 while(cursor){const page=await request<Snapshot>(`/conversations/${id}/snapshot?cursor=${encodeURIComponent(JSON.stringify(cursor))}`,{signal});first.entries.push(...page.entries);cursor=page.cursor;}return first;
}
export function Chat({id}:{id:string}){
 const [snapshot,setSnapshot]=useState<Snapshot>(),[revision,setRevision]=useState(0),[error,setError]=useState(''),[text,setText]=useState(''),[accepted,setAccepted]=useState<string[]>([]),[sending,setSending]=useState(false);
 const [retries,setRetries]=useState(0);
 useEffect(()=>{setSnapshot(undefined);const controller=new AbortController();void loadSnapshot(id,controller.signal).then(s=>{setSnapshot(s);setAccepted([]);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>controller.abort();},[id,revision]);
 const send=useMemo(()=>createSubmitter(command=>request(`/conversations/${id}/runs`,{method:'POST',body:JSON.stringify(command)})),[id]);
 const submit=async(message:string,source?:RunCommand['source'])=>{
  await send(message,source);
  setAccepted(a=>[...a,message]);setRetries(0);setError('');if(!snapshot?.pending.length)setRevision(r=>r+1);
 };
 const refresh=()=>{setRetries(0);setRevision(r=>r+1);};
 const reconnect=(replacement=false)=>{if(!replacement&&retries>=4){setError('恢复观察失败。任务仍在后端运行，可以重新连接。');return;}if(!replacement)setRetries(n=>n+1);setTimeout(()=>setRevision(r=>r+1),replacement?0:Math.min(500*2**retries,4000));};
 useEffect(()=>{if(!snapshot?.stopping)return;const timer=setTimeout(()=>setRevision(r=>r+1),1000);return()=>clearTimeout(timer);},[snapshot]);
 return <div className="chat">
  {snapshot?<Runtime key={revision} id={id} snapshot={snapshot} submit={submit} done={refresh} reconnect={reconnect}/>:<p role="status">正在恢复聊天…</p>}
  {accepted.length>0&&<aside aria-label="已接受的任务"><p>任务已接受，忙碌时按顺序执行</p>{accepted.map((message,i)=><p key={i}>{message}</p>)}</aside>}
  {snapshot?.pending.length!==0&&snapshot&&<p role="status">{snapshot.pending.filter(p=>p.status==='queued').length} 项排队{snapshot.stopping?' · 正在停止…':''}</p>}
  {error&&<p role="alert">{error} <Button onClick={()=>{setRetries(0);setError('');setRevision(r=>r+1);}}>重新连接</Button></p>}
  <form className="composer" onSubmit={async e=>{e.preventDefault();if(!text.trim()||sending)return;setSending(true);try{await submit(text);setText('');}catch(e){setError((e as Error).message);}finally{setSending(false);}}}>
   <label htmlFor="message">消息</label><textarea id="message" value={text} onChange={e=>setText(e.target.value)} placeholder="描述你的问题，或请求一个可交互的分析面板" rows={3} disabled={snapshot?.stopping}/>
   <div><Button type="submit" disabled={!text.trim()||sending||snapshot?.stopping}>{sending?'提交中…':'发送'}</Button><Button type="button" disabled={!snapshot?.pending.length||snapshot.stopping} onClick={async()=>{try{await request(`/conversations/${id}/stop`,{method:'POST'});refresh();}catch(e){setError((e as Error).message);}}}>停止并撤回排队</Button></div>
  </form>
 </div>;
}
function Runtime({id,snapshot,submit,done,reconnect}:{id:string;snapshot:Snapshot;submit:(text:string,source?:RunCommand['source'])=>Promise<void>;done:()=>void;reconnect:(replacement?:boolean)=>void}){
 const history=useMemo<ThreadHistoryAdapter>(()=>({append:async()=>{},load:async()=>{
  const messages=fromAgUiMessages(toMessages(snapshot.entries),{showThinking:false}).map(m=>fromThreadMessageLike(m,m.id!,{type:'complete',reason:'stop'}));
  return {messages:messages.map((message,i)=>({parentId:i?messages[i-1].id:null,message})),headId:messages.at(-1)?.id??null};
 }}),[snapshot]);
 const callbacks=useRef({done,reconnect});callbacks.current={done,reconnect};
 const agent=useMemo(()=>new AttachAgent(id,()=>callbacks.current.done(),()=>callbacks.current.reconnect()),[id]);
 const runtime=useAgUiRuntime({agent,adapters:{history},showThinking:false,autoCancelPendingToolCalls:false,onError:e=>callbacks.current.reconnect(e instanceof StreamReplaced)});
 useEffect(()=>{const pending=snapshot.pending.find(p=>p.status==='running')??snapshot.pending[0];if(!pending)return;void runtime.thread.resumeRun({parentId:runtime.thread.getState().messages.at(-1)?.id??null,runConfig:{custom:{mode:'attach',runId:pending.operationId}}});return()=>agent.abortRun();},[runtime,agent,snapshot]);
 return <AssistantRuntimeProvider runtime={runtime}><ChatContext value={{id,submit}}><ThreadPrimitive.Root aria-label="聊天历史"><ThreadPrimitive.Messages components={{UserMessage:User,AssistantMessage:Assistant}}/></ThreadPrimitive.Root></ChatContext></AssistantRuntimeProvider>;
}

const ChatContext=createContext<{id:string;submit:(text:string,source?:RunCommand['source'])=>Promise<void>}|null>(null);
function Tool(part:ToolCallMessagePartProps){
 const {id,submit}=useContext(ChatContext)!;
 if(part.toolName==='present_openui'){
  const preview=typeof part.args?.ui==='string'?part.args.ui:partialUI(part.argsText??'');
  let result=part.result;if(typeof result==='string'){try{result=JSON.parse(result);}catch{result=undefined;}}
  const panelRef=(result as any)?.panelRef;
  if(part.isError)return <details className="tool" open><summary>界面未发布</summary><p role="alert">{typeof part.result==='string'?part.result:JSON.stringify(part.result)}</p></details>;
  return <Panel key={panelRef??part.toolCallId} conversationId={id} panelRef={typeof panelRef==='string'?panelRef:undefined} preview={preview} submit={submit}/>;
 }
 return <details className="tool"><summary>{part.toolName}{part.isError?' · 失败':part.result!==undefined?' · 已完成':' · 执行中'}</summary><pre>{typeof part.result==='string'?part.result:JSON.stringify(part.result,null,2)}</pre></details>;
}
function Assistant(){return <MessagePrimitive.Root className="message assistant"><MessagePrimitive.Parts components={{tools:{Fallback:Tool}}}/></MessagePrimitive.Root>;}
function User(){return <MessagePrimitive.Root className="message user"><MessagePrimitive.Parts/></MessagePrimitive.Root>;}
