import { parsePartialJsonObject } from 'assistant-stream/utils';
export function partialUI(argsText: string) {
  const value = parsePartialJsonObject(argsText);
  return typeof value?.ui === 'string' ? value.ui : undefined;
}
