import {lazy,Suspense,useEffect,useState} from 'react';
import {authClient} from './auth';
import {request} from './api';
import {Button} from './ui/button';
const Chat=lazy(()=>import('./Chat').then(module=>({default:module.Chat})));
type Conversation={id:string;title:string;updated_at:number};
type Directory={items:Conversation[];next:string|null};
function selectedChat(){return new URL(location.href).searchParams.get('chat')??'';}
export function App(){
 const {data:session,isPending,error:sessionError,refetch}=authClient.useSession();
 const [error,setError]=useState(''),[signingIn,setSigningIn]=useState(false);
 if(isPending)return <main className="welcome"><p role="status">正在恢复登录状态…</p></main>;
 if(!session)return <main className="welcome">
  <span className="wordmark">AGENT / GENERATIVE UI</span>
  <h1>把问题变成<br/>可以操作的答案。</h1>
  <p className="welcome-description">对话、探索和调整参数。在自己的聊天中继续每一项任务。</p>
  <Button size="lg" disabled={signingIn||!!sessionError} onClick={async()=>{setSigningIn(true);setError('');try{const result=await authClient.signIn.social({provider:'google',callbackURL:location.origin});if(result.error)throw new Error(result.error.message??'登录失败，请重试');}catch(e){setError((e as Error).message);}finally{setSigningIn(false);}}}>{signingIn?'正在打开登录…':'使用 Google 登录'}</Button>
  {(error||sessionError)&&<p className="notice error" role="alert">{error||sessionError?.message||'无法读取登录配置，请检查服务端设置'} {sessionError&&<Button variant="link" onClick={()=>void refetch()}>重试</Button>}</p>}
  <p className="fine-print">登录后，聊天和输入仅保存在你的个人会话中。</p>
 </main>;
 return <Workspace key={session.user.id} name={session.user.name}/>;
}
function Workspace({name}:{name:string}){
 const [items,setItems]=useState<Conversation[]>([]),[next,setNext]=useState<string|null>(null),[id,setId]=useState(selectedChat),[menu,setMenu]=useState(false),[error,setError]=useState(''),[loading,setLoading]=useState(true),[creating,setCreating]=useState(false),[version,setVersion]=useState(0);
 useEffect(()=>{const controller=new AbortController();setLoading(true);void request<Directory>('/conversations',{signal:controller.signal}).then(data=>{setItems(data.items);setNext(data.next);setError('');}).catch(e=>{if(!controller.signal.aborted)setError(e.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});return()=>controller.abort();},[version]);
 useEffect(()=>{const pop=()=>{setId(selectedChat());setMenu(false);};addEventListener('popstate',pop);return()=>removeEventListener('popstate',pop);},[]);
 const choose=(value:string)=>{const url=new URL(location.href);url.searchParams.set('chat',value);history.pushState(null,'',url);setId(value);setMenu(false);};
 const create=async()=>{if(creating)return;setCreating(true);try{const chat=await request<{id:string;title:string}>('/conversations',{method:'POST'});setItems(current=>[{...chat,updated_at:Date.now()},...current]);choose(chat.id);setError('');}catch(e){setError((e as Error).message);}finally{setCreating(false);}};
 const current=items.find(item=>item.id===id);
 return <div className="workspace">
  <a className="skip-link" href="#conversation">跳到聊天</a>
  <header className="app-header"><Button className="mobile-menu" variant="ghost" aria-label={menu?'关闭聊天目录':'打开聊天目录'} aria-expanded={menu} aria-controls="chat-directory" onClick={()=>setMenu(!menu)}>☰</Button><a className="wordmark" href="/">AGENT / UI</a><span className="account-name">{name}</span><Button variant="ghost" onClick={async()=>{try{const result=await authClient.signOut();if(result.error)throw new Error(result.error.message??'退出失败');}catch(e){setError((e as Error).message);}}}>退出</Button></header>
  <aside id="chat-directory" className={'directory '+(menu?'is-open':'')} aria-label="个人聊天目录">
   <div className="directory-heading"><h2>你的聊天</h2><Button size="sm" disabled={creating} onClick={()=>void create()}>{creating?'创建中…':'新建聊天'}</Button></div>
   {loading&&<p role="status" className="muted">正在读取目录…</p>}
   {!loading&&!items.length&&<p className="muted">第一段对话，从这里开始。</p>}
   <nav>{items.map(item=><Button variant="ghost" className="chat-link" key={item.id} aria-current={id===item.id?'page':undefined} onClick={()=>choose(item.id)}><span>{item.title}</span><time dateTime={new Date(item.updated_at).toISOString()}>{new Date(item.updated_at).toLocaleDateString('zh-CN',{month:'short',day:'numeric'})}</time></Button>)}</nav>
   {next&&<Button variant="ghost" onClick={async()=>{try{const data=await request<Directory>('/conversations?cursor='+encodeURIComponent(next));setItems(old=>[...old,...data.items]);setNext(data.next);}catch(e){setError((e as Error).message);}}}>更多聊天</Button>}
   <Button variant="link" className="refresh-directory" onClick={()=>setVersion(v=>v+1)}>刷新目录</Button>
  </aside>
  <main id="conversation" className="conversation" tabIndex={-1}>
   {error&&<p role="alert" className="notice error">{error}</p>}
   {id?<><div className="conversation-heading"><h1>{current?.title??'聊天'}</h1><span className="muted">离开页面后，任务会继续运行</span></div><Suspense fallback={<p role="status">正在打开聊天…</p>}><Chat key={id} id={id}/></Suspense></>:<div className="empty-chat"><span className="wordmark">YOUR NEXT IDEA</span><h1>从一个问题开始。</h1><p>需要解释时，直接对话。需要比较和模拟时，让 Agent 生成可交互的面板。</p><Button onClick={()=>void create()} disabled={creating}>开始新聊天</Button></div>}
  </main>
 </div>;
}
