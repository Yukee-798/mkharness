import type { Toolkit } from '@assistant-ui/react';
import { createContext, useContext } from 'react';
import type { RunCommand } from '../shared/contracts';
import type { ExtensionDecoration } from './extensions';
import type { ExtensionState } from '../shared/extension-state';
export type ExtensionContextValue = {
  id: string;
  userId: string;
  submit: (text: string, source?: RunCommand['source']) => Promise<void>;
  busy?: boolean;
  toolkit: Toolkit;
  activity: Readonly<Record<string, 'visible' | 'hidden'>>;
  ui?: readonly ExtensionDecoration[];
  state?: ExtensionState;
  messageIds?: ReadonlyMap<string, string>;
};
export const ExtensionContext = createContext<ExtensionContextValue | null>(null);
export function useExtensionContext() {
  const context = useContext(ExtensionContext);
  if (!context) throw new Error('Extension renderer requires a conversation context');
  return context;
}
export function canonicalMessageId(id: string, aliases?: ReadonlyMap<string, string>) {
  for (const [canonical, live] of aliases ?? []) if (live === id) return canonical;
  return id;
}
