import {env} from 'cloudflare:test';
import {it,expect} from 'vitest';
async function generate(stub:ReturnType<typeof env.CONVERSATIONS.getByName>){
 await stub.submitRun({runId:crypto.randomUUID(),text:'panel'});
 for(let i=0;i<100;i++){const s=JSON.parse(await stub.snapshot());if(s.pending.length===0)return s;await new Promise(r=>setTimeout(r,20));}
 throw new Error('Panel did not settle');
}
it('publishes from committed tools, preserves raw input and rejects conflicting saves',async()=>{
 const stub=env.CONVERSATIONS.getByName(crypto.randomUUID());const s=await generate(stub);
 const tool=s.entries.flatMap((e:any)=>e.model??[]).find((m:any)=>m.role==='toolResult'&&m.toolName==='present_openui'&&!m.isError);
 expect(tool).toBeDefined();const ref=tool.details.ref;
 const loaded=JSON.parse(await stub.loadPanel(ref));expect(loaded.program.data).toEqual({factor:2});expect(loaded.revision).toBe(0);
 expect(await stub.savePanelState(ref,{$cost:''},0)).toMatchObject({revision:1});
 expect(await stub.savePanelState(ref,{$cost:'120'},0)).toMatchObject({error:{status:409}});
 expect(JSON.parse(await stub.loadPanel(ref)).state).toEqual({$cost:''});
 expect(await stub.savePanelState(ref,{$cost:'1.'},1)).toMatchObject({revision:2});
 const next=await generate(stub);const tools=next.entries.flatMap((e:any)=>e.model??[]).filter((m:any)=>m.role==='toolResult'&&m.toolName==='present_openui'&&!m.isError);
 const newRef=tools.at(-1).details.ref;expect(newRef).not.toBe(ref);
 expect(JSON.parse(await stub.loadPanel(newRef)).revision).toBe(0);
 expect(JSON.parse(await stub.loadPanel(ref)).state).toEqual({$cost:'1.'});
});
