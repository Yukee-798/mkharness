import { createContext, useContext } from 'react';
import type { ToolProgressMap } from '../shared/tool-progress';
export const ToolProgressContext = createContext<ToolProgressMap>({});
export function useToolProgress(callId: string) {
  return useContext(ToolProgressContext)[callId];
}
