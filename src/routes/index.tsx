import { ClientOnly, createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

const Application = lazy(() => import('../browser/application'));

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>): { chat?: string } => ({
    chat:
      typeof search.chat === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(search.chat)
        ? search.chat
        : undefined,
  }),
  component: ChatApplication,
});

function LoadingShell() {
  return (
    <main aria-label="聊天应用" className="flex h-dvh items-center justify-center">
      <p role="status" className="text-sm text-muted-foreground">
        正在加载应用…
      </p>
    </main>
  );
}

function ChatApplication() {
  return (
    <ClientOnly fallback={<LoadingShell />}>
      <Suspense fallback={<LoadingShell />}>
        <Application />
      </Suspense>
    </ClientOnly>
  );
}
