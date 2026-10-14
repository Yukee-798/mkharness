import { App } from './App';
import { LocaleProvider } from './locale';
export default function Application() {
  return (
    <LocaleProvider>
      <App />
    </LocaleProvider>
  );
}
