import type {RawState} from '../shared/contracts';
export type SaveStatus='saved'|'saving'|'unsaved'|'error'|'conflict';
export function createDraftSaver(save:(state:RawState,revision:number)=>Promise<number>,initialRevision:number,report:(status:SaveStatus)=>void){
 let state:RawState={},revision=initialRevision,version=0,persisted=0,inflight=false,disposed=false,blocked=false,conflict=false;
 let timer:ReturnType<typeof setTimeout>|undefined;
 const schedule=()=>{clearTimeout(timer);if(!disposed&&!blocked)timer=setTimeout(()=>void flush(),500);};
 const flush=async()=>{
  if(disposed||blocked||inflight||version===persisted)return;
  const saving=version,snapshot=structuredClone(state);inflight=true;report('saving');
  try{revision=await save(snapshot,revision);persisted=saving;if(!disposed)report(version===persisted?'saved':'unsaved');}
  catch(error){blocked=true;conflict=(error as {status?:number})?.status===409;if(!disposed)report(conflict?'conflict':'error');}
  finally{inflight=false;if(!disposed&&!blocked&&version!==persisted)schedule();}
 };
 return {
  update:(next:RawState)=>{state=structuredClone(next);version++;if(!blocked)report('unsaved');schedule();},
  retry:()=>{if(disposed||conflict)return;blocked=false;schedule();},
  current:()=>structuredClone(state),
  dispose:()=>{disposed=true;clearTimeout(timer);},
 };
}
