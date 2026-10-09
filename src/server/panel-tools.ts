import {Type} from '@earendil-works/pi-ai';
import {defineTool,type Extension,type ToolExecutionApi,type Harness} from '@earendil-works/pi-durable';
import {createParser} from '@openuidev/lang-core';
import {library} from '../shared/catalog';
import {toolRef,successfulTool} from '../shared/references';
import {jsonText,finiteJson,type Json,type Program} from '../shared/compute';
import {computeProgram} from './compute';
async function ref(api:ToolExecutionApi,context:Parameters<Harness['close']>[0]){
 const task=await api.getTask(api.taskId,context);const input=task?.input;
 if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.assistant!=='number')throw new Error('Missing Pi calling entry');
 return toolRef(input.assistant,api.callId);
}
export function validateUI(ui:string,hasProgram:boolean){
 if(new TextEncoder().encode(ui).length>262144)throw new Error('UI exceeds 256 KiB');
 const parsed=createParser(library.toJSONSchema()).parse(ui);
 if(!parsed.root||parsed.meta.incomplete||parsed.meta.unresolved.length||parsed.meta.errors.length)throw new Error('Invalid OpenUI: '+JSON.stringify(parsed.meta));
 if(parsed.mutationStatements.length)throw new Error('Mutation is not available; use the continue_analysis host action');
 for(const query of parsed.queryStatements){if(!hasProgram||query.toolAST?.k!=='Str'||query.toolAST.v!=='run_program')throw new Error('Only the bound run_program Query is available');}
 const pending:unknown[]=[parsed.root];while(pending.length){const value=pending.pop();if(!value||typeof value!=='object')continue;const v=value as Record<string,unknown>;if(hasProgram&&v.typeName==='StateSync'&&!(v.props as Record<string,unknown>)?.computed)throw new Error('StateSync requires computation provenance {result,inputs}');for(const child of Object.values(v))if(child&&typeof child==='object')pending.push(child);}
 return parsed;
}
export function panelTools(entries:()=>Promise<readonly import('@earendil-works/pi-durable').EntryRecord[]>):Extension {
 const prepare=defineTool({name:'prepare_program',description:'Validate a generated synchronous ES module compute(inputs,data), initial inputs and finite JSON test cases. No imports, host APIs, clock or randomness. Returns programRef and initial result.',parameters:Type.Object({code:Type.String({maxLength:65536}),initialInputs:Type.Unknown(),data:Type.Unknown(),cases:Type.Array(Type.Object({inputs:Type.Unknown(),expected:Type.Unknown()}),{minItems:1,maxItems:10})}),replay:'safe',execute:async(args,api,context)=>{
  try{
   finiteJson(args.initialInputs);finiteJson(args.data);jsonText(args.cases);
   const program:Program={code:args.code,data:args.data};const initial=await computeProgram(program,args.initialInputs);if(!initial.ok)throw new Error(initial.error.kind+': '+initial.error.message);
   for(const example of args.cases){finiteJson(example.inputs);finiteJson(example.expected);const computed=await computeProgram(program,example.inputs);if(!computed.ok)throw new Error(computed.error.message);if(jsonText(computed.value)!==jsonText(example.expected))throw new Error('Test case output differs from expected');}
   const programRef=await ref(api,context);
   return {content:[{type:'text',text:JSON.stringify({programRef,initial:initial.value})}],details:{ref:programRef,initial:initial.value}};
  }catch(error){return {isError:true,content:[{type:'text',text:error instanceof Error?error.message:'Invalid program'}]};}
 }});
 const present=defineTool({name:'present_openui',description:'Publish complete OpenUI Lang using the supplied component catalog. Optional programRef must refer to a committed successful prepare_program in this chat. Use native Query/Set/Reset and the continue_analysis host action.',parameters:Type.Object({ui:Type.String({maxLength:262144}),programRef:Type.Optional(Type.String({maxLength:512}))}),replay:'safe',execute:async(args,api,context)=>{
  try{
   if(args.programRef&&!successfulTool(await entries(),args.programRef,'prepare_program'))throw new Error('Program is missing or has not committed successfully');
   validateUI(args.ui,!!args.programRef);const panelRef=await ref(api,context);
   return {content:[{type:'text',text:JSON.stringify({panelRef,ready:true})}],details:{ref:panelRef}};
  }catch(error){return {isError:true,content:[{type:'text',text:error instanceof Error?error.message:'Invalid UI'}]};}
 }});
 return {name:'panels',tools:[prepare,present],sections:[{key:'ui',render:()=>library.prompt({additionalRules:['Produce ordinary text when no interface helps. For complex computation, first prepare_program and wait for success, then present_openui referencing its programRef. UI defaults must reflect initialInputs and any submitted source.state. Parameter edits use run_program locally. Use Action([@ToAssistant("Analyze with these inputs")]) for another agent request. Prefer text inputs for numeric parameters when preserving unfinished decimal edits matters. Never invent a tool or business function. Show assumptions, units and source descriptions. StateSync(value,next,enabled,{result:theFullQueryResult,inputs:theSameCurrentQueryArguments}) is optional for automatic parameter normalization, not required for derived display values. For StateSync with a program, return an object from compute and pass its complete Query result and current inputs so the host can reject stale or mismatched writeback.']})}]};
}
