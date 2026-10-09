import {createContext,useContext,useEffect,useRef} from 'react';
import {createLibrary,defineComponent,reactive,useStateField,useIsQueryLoading,useIsStreaming} from '@openuidev/react-lang';
import {openuiLibrary} from '@openuidev/react-ui/genui-lib';
import {z} from 'zod';
import {finiteJson} from './compute';
export type PanelGuard={epoch:number;ready:boolean;halted:boolean;isCurrent?:(frame:unknown)=>boolean;report:(message:string)=>void};
export const PanelContext=createContext<PanelGuard|null>(null);
export const StateSync=defineComponent({name:'StateSync',description:'Write next into a single declared reactive binding when enabled and current computation is ready. For program-backed writes, computed must be {result: the full Query result, inputs: the same current arguments used by Query}; the result must be an object. Maximum three automatic writes per user editing chain.',props:z.object({value:reactive(z.unknown()),next:z.unknown(),enabled:z.boolean(),computed:z.object({result:z.unknown(),inputs:z.unknown()}).optional()}),component:({props})=>{
 const guard=useContext(PanelContext),field=useStateField('StateSync',props.value),streaming=useIsStreaming(),loading=useIsQueryLoading();
 const chain=useRef({epoch:-1,writes:0,halted:false});
 useEffect(()=>{
  if(!guard)return;
  if(chain.current.epoch!==guard.epoch)chain.current={epoch:guard.epoch,writes:0,halted:false};
  if(!props.enabled||streaming||loading||!guard.ready||chain.current.halted)return;
  if(guard.isCurrent&&!guard.isCurrent(props.computed))return;
  try{finiteJson(props.next);}catch{guard.report('Automatic update is not finite JSON');return;}
  if(JSON.stringify(field.value)===JSON.stringify(props.next))return;
  if(chain.current.writes>=3){chain.current.halted=true;guard.halted=true;guard.report('Automatic input updates did not converge. Edit an input to retry.');return;}
  chain.current.writes++;field.setValue(props.next);
 },[guard,field.value,field.setValue,props.next,props.enabled,props.computed,streaming,loading]);
 return null;
}});
export const library=createLibrary({root:openuiLibrary.root,components:[...Object.values(openuiLibrary.components),StateSync]});
