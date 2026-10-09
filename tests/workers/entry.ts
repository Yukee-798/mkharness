import {ConversationAgent as Base} from '../../src/server/conversation';
import {fixtureModels} from '../fixture-model';
import {Type} from '@earendil-works/pi-ai';
import {defineTool} from '@earendil-works/pi-durable';
export class ConversationAgent extends Base {
 protected override models(){return fixtureModels();}
 protected override extensions(){return [...super.extensions(),{name:'fixture',tools:[defineTool({name:'ignores_cancel',description:'Test-only uncancellable bounded tool',parameters:Type.Object({}),replay:'safe',execute:async()=>{await new Promise(r=>setTimeout(r,800));return {content:[{type:'text' as const,text:'completed'}]};}})]}];}
}
export default {fetch:()=>new Response('test fixture')};
