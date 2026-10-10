import { createRoot } from 'react-dom/client';
import { ThemeProvider } from '@openuidev/react-ui';
import { Panel } from '../../src/browser/Panel';
import { openUITheme } from '../../src/browser/openui-theme';
import '@openuidev/react-ui/index.css';
import '../../src/browser/styles.css';
(window as any).submissions = [];
const submit = async (text: string, source: unknown) => {
  (window as any).submissions.push({ text, source });
};
createRoot(document.getElementById('root')!).render(
  <ThemeProvider lightTheme={openUITheme}>
    <Panel conversationId="test" panelRef="2.same" submit={submit} />
    <Panel conversationId="test" panelRef="8.same" submit={submit} />
  </ThemeProvider>,
);
