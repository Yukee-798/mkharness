import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { createResourceDrafts } from './draft';
const Context = createContext<ReturnType<typeof createResourceDrafts> | null>(null);
export function useResourceDrafts() {
  const inherited = useContext(Context),
    [local] = useState(createResourceDrafts);
  useEffect(
    () => () => {
      if (!inherited) local.dispose();
    },
    [inherited, local],
  );
  return inherited ?? local;
}
export function ResourceDrafts({ children }: { children: ReactNode }) {
  const drafts = useResourceDrafts();
  return <Context value={drafts}>{children}</Context>;
}
