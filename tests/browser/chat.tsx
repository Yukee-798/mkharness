import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Chat } from '../../src/browser/Chat';
import '@openuidev/react-ui/styles/index.css';
function App() {
  const [id, setId] = useState('a');
  return (
    <>
      <button onClick={() => setId(id === 'a' ? 'b' : 'a')}>切换聊天</button>
      <Chat key={id} id={id} />
    </>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
