import { createRoot } from 'react-dom/client';
import { ThemeProvider } from '@openuidev/react-ui';
import { App } from './App';
import { openUITheme } from './openui-theme';
import '@openuidev/react-ui/index.css';
import './styles.css';
createRoot(document.getElementById('root')!).render(
  <ThemeProvider lightTheme={openUITheme}>
    <App />
  </ThemeProvider>,
);
