import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from '@openuidev/react-ui';
import { Chat } from '../../src/browser/Chat';
import { openUITheme } from '../../src/browser/openui-theme';
import '@openuidev/react-ui/styles/index.css';
import '../../src/browser/styles.css';
function App() {
  const [id, setId] = useState('a');
  return (
    <div className="flex h-dvh flex-col">
      <button onClick={() => setId(id === 'a' ? 'b' : 'a')}>切换聊天</button>
      <Chat key={id} id={id} />
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <ThemeProvider lightTheme={openUITheme}>
    <App />
  </ThemeProvider>,
);
