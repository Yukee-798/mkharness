import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { createResourceDrafts } from './draft';
const Context = createContext<ReturnType<typeof createResourceDrafts> | null>(null);
export function useResourceDrafts(scope?: string) {
  const inherited = useContext(Context),
    local = useMemo(() => ({ scope, drafts: createResourceDrafts() }), [scope]).drafts;
  useEffect(
    () => () => {
      if (!inherited) local.dispose();
    },
    [inherited, local],
  );
  return inherited ?? local;
}
export function ResourceDrafts({ children, scope }: { children: ReactNode; scope?: string }) {
  const drafts = useResourceDrafts(scope);
  return <Context value={drafts}>{children}</Context>;
}
