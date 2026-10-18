import { createFileRoute } from '@tanstack/react-router';
import { App } from '../browser/app/App';
import { LocaleProvider } from '../browser/app/locale';
import { initialLocale } from '../browser/app/initial-locale';

export const Route = createFileRoute('/')({
  validateSearch: (
    search: Record<string, unknown>,
  ): { chat?: string; view?: 'agent' | 'schedules' | 'plugins'; mcp?: 'connected' | 'error' } => ({
    view: search.view === 'schedules' || search.view === 'plugins' ? search.view : undefined,
    mcp: search.mcp === 'connected' || search.mcp === 'error' ? search.mcp : undefined,
    chat:
      typeof search.chat === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(search.chat)
        ? search.chat
        : undefined,
  }),
  component: ChatApplication,
  loader: () => initialLocale(),
});

function ChatApplication() {
  const locale = Route.useLoaderData();
  return (
    <LocaleProvider initialLocale={locale}>
      <App />
    </LocaleProvider>
  );
}
