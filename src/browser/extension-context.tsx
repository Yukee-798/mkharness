import type { Toolkit } from '@assistant-ui/react';
import { createContext, useContext } from 'react';
import type { RunCommand } from '../shared/contracts';
export type ExtensionContextValue = {
  id: string;
  userId: string;
  submit: (text: string, source?: RunCommand['source']) => Promise<void>;
  toolkit: Toolkit;
  activity: Readonly<Record<string, 'visible' | 'hidden'>>;
};
export const ExtensionContext = createContext<ExtensionContextValue | null>(null);
export function useExtensionContext() {
  const context = useContext(ExtensionContext);
  if (!context) throw new Error('Extension renderer requires a conversation context');
  return context;
}
