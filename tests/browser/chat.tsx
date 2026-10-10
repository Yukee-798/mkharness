import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from '@openuidev/react-ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Chat } from '../../src/browser/Chat';
import { openUITheme } from '../../src/browser/openui-theme';
import '@openuidev/react-ui/styles/index.css';
import '../../src/browser/styles.css';
function App() {
  const [id, setId] = useState('a');
  return (
    <div className="flex h-dvh flex-col">
      <button onClick={() => setId(id === 'a' ? 'b' : 'a')}>切换聊天</button>
      <Chat key={id} id={id} userId="fixture-user" />
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <ThemeProvider lightTheme={openUITheme}>
    <QueryClientProvider client={new QueryClient()}>
      <App />
    </QueryClientProvider>
  </ThemeProvider>,
);
