import { createFileRoute } from '@tanstack/react-router';
import { ConversationError } from '../browser/chat/ConversationError';
import { recordConversationStoreError } from '../browser/chat/session/diagnostics';
import { App } from '../browser/app/App';
import { LocaleProvider } from '../browser/app/locale';
import { initialLocale } from '../browser/app/initial-locale';

export const Route = createFileRoute('/')({
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    chat?: string;
    scenario?: string;
    view?: 'agent' | 'canvas' | 'schedules' | 'plugins';
    mcp?: 'connected' | 'error';
  } => ({
    scenario:
      typeof search.scenario === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(search.scenario)
        ? search.scenario
        : undefined,
    view:
      search.view === 'canvas' || search.view === 'schedules' || search.view === 'plugins'
        ? search.view
        : undefined,
    mcp: search.mcp === 'connected' || search.mcp === 'error' ? search.mcp : undefined,
    chat:
      typeof search.chat === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(search.chat)
        ? search.chat
        : undefined,
  }),
  component: ChatApplication,
  onCatch: recordConversationStoreError,
  errorComponent: ConversationError,
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
