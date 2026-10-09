import {createContext,useContext,useEffect,useState,type ReactNode} from 'react';
import {createPanelDrafts} from './draft';
const Context=createContext<ReturnType<typeof createPanelDrafts>|null>(null);
export function usePanelDrafts(){
 const inherited=useContext(Context),[local]=useState(createPanelDrafts);
 useEffect(()=>()=>{if(!inherited)local.dispose();},[inherited,local]);
 return inherited??local;
}
export function PanelDrafts({children}:{children:ReactNode}){
 const drafts=usePanelDrafts();return <Context value={drafts}>{children}</Context>;
}
