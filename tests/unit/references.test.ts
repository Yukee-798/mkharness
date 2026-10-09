import {it,expect} from 'vitest';
import type {EntryRecord} from '@earendil-works/pi-durable';
import {successfulTool} from '../../src/shared/references';
const entry=(id:number,role:string,content:unknown,details?:unknown,isError=false)=>({id,conversationId:1,kind:role==='assistant'?'pi.assistant':'pi.toolResult',model:[{role,content,toolCallId:'same',toolName:'prepare_program',details,isError}],createdAt:0}) as unknown as EntryRecord;
it('resolves duplicated call ids by assistant entry and successful result',()=>{
 const entries=[entry(2,'assistant',[{type:'toolCall',id:'same',name:'prepare_program',arguments:{code:'old'}}]),entry(3,'toolResult',[],{ref:'2.same'}),entry(8,'assistant',[{type:'toolCall',id:'same',name:'prepare_program',arguments:{code:'new'}}]),entry(9,'toolResult',[],{ref:'8.same'},true)];
 expect(successfulTool(entries,'2.same','prepare_program')?.args.code).toBe('old');
 expect(successfulTool(entries,'8.same','prepare_program')).toBeUndefined();
 expect(successfulTool(entries,'2.same','present_openui')).toBeUndefined();
});
