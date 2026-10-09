import {env,applyD1Migrations} from 'cloudflare:test';
import {beforeAll,it,expect} from 'vitest';
import migration from '../../migrations/0001_auth_and_conversations.sql?raw';
import {makeSignature} from 'better-auth/crypto';
import app from '../../src/server/index';
const cookie=async(token:string)=>'better-auth.session_token='+encodeURIComponent(token+'.'+await makeSignature(token,env.BETTER_AUTH_SECRET));
beforeAll(async()=>{
 await applyD1Migrations(env.DB,[{name:'0001',queries:migration.split(';').filter(s=>s.trim())}]);
 for(const id of ['a','b']){
   await env.DB.prepare('INSERT INTO user VALUES(?,?,?,1,NULL,?,?)').bind(id,id,id+'@example.com',Date.now(),Date.now()).run();
   await env.DB.prepare('INSERT INTO session VALUES(?,?,?,?,?,NULL,NULL,?)').bind(id,Date.now()+86400000,'token-'+id,Date.now(),Date.now(),id).run();
 }
});
it('rejects unauthenticated requests with 401',async()=>expect((await app.request('http://localhost:5173/api/conversations',{},env)).status).toBe(401));
it('isolates listing and every resource operation using real Better Auth sessions',async()=>{
 const a=await cookie('token-a'),b=await cookie('token-b');
 const created=await app.request('http://localhost:5173/api/conversations',{method:'POST',headers:{cookie:a,origin:env.APP_URL}},env);
 expect(created.status).toBe(201);const {id}=await created.json() as {id:string};
 const list=await app.request('http://localhost:5173/api/conversations',{headers:{cookie:b}},env);expect(await list.json()).toEqual({items:[],next:null});
 for(const [path,method] of [['snapshot','GET'],['runs','POST'],['runs/abc/events','GET'],['stop','POST'],['panels/1.call','GET'],['panels/1.call/state','PATCH']]){
 const response=await app.request('http://localhost:5173/api/conversations/'+id+'/'+path,{method,headers:{cookie:b,origin:env.APP_URL,'Content-Type':'application/json'},body:method==='GET'?undefined:'{}'},env);expect(response.status).toBe(404);
 }
});
