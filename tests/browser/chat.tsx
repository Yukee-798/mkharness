import { LocaleProvider } from '../../src/browser/app/locale';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Chat } from '../../src/browser/chat/Chat';
import '../../src/browser/styles.css';
function App() {
  const [id, setId] = useState(new URLSearchParams(location.search).get('chat') ?? 'a');
  return (
    <div className="flex h-dvh flex-col">
      <button onClick={() => setId(id === 'a' ? 'b' : 'a')}>切换聊天</button>
      <Chat key={id} id={id} userId="fixture-user" />
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <LocaleProvider>
    <>
      <QueryClientProvider client={new QueryClient()}>
        <App />
      </QueryClientProvider>
    </>
  </LocaleProvider>,
);
