import {createRoot} from 'react-dom/client';
import {Panel} from '../../src/browser/Panel';
import '@openuidev/react-ui/index.css';
(window as any).submissions=[];
const submit=async(text:string,source:unknown)=>{(window as any).submissions.push({text,source});};
createRoot(document.getElementById('root')!).render(<><Panel conversationId="test" panelRef="2.same" submit={submit}/><Panel conversationId="test" panelRef="8.same" submit={submit}/></>);
