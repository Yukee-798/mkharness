import { ThemeProvider } from '@openuidev/react-ui';
import { App } from './App';
import { openUITheme } from './openui-theme';

export default function Application() {
  return (
    <ThemeProvider lightTheme={openUITheme}>
      <App />
    </ThemeProvider>
  );
}
