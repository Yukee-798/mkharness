// Preload real catalog in test setup: Vite serves its module graph over HTTP, unlike bundled Cloudflare modules.
import '../../src/shared/catalog';
import {ConversationAgent as Base} from '../../src/server/conversation';
import {fixtureModels} from '../fixture-model';
import {Type} from '@earendil-works/pi-ai';
import {defineTool,type ToolRegistration,type ToolExecutionApi} from '@earendil-works/pi-durable';
export class ConversationAgent extends Base {
 protected override models(){return fixtureModels();}
 protected override extensions(){return [...super.extensions(),{name:'fixture',wraps:[{tool:'present_openui',wrap:(tool:ToolRegistration)=>({...tool,execute:async(args:any,api:ToolExecutionApi,context:Parameters<ToolRegistration['execute']>[2])=>{const result=await tool.execute(args,api,context);const sql=this.ctx.storage.sql;const armed=sql.exec("SELECT name FROM sqlite_master WHERE name='test_fault'").toArray().length&&sql.exec("SELECT value FROM test_fault WHERE key='armed'").toArray()[0]?.value;if(armed){sql.exec("INSERT INTO test_fault VALUES('reached',1) ON CONFLICT(key) DO NOTHING");await new Promise(r=>setTimeout(r,500));sql.exec("UPDATE test_fault SET value=0 WHERE key='armed'");}return result;}})}],tools:[defineTool({name:'ignores_cancel',description:'Test-only uncancellable bounded tool',parameters:Type.Object({}),replay:'safe',execute:async()=>{await new Promise(r=>setTimeout(r,800));return {content:[{type:'text' as const,text:'completed'}]};}})]}];}
}
export default {fetch:()=>new Response('test fixture')};
