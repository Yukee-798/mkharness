import type { EntryRecord } from '@earendil-works/pi-durable';
export function toolRef(entryId: number, callId: string) {
  return `${entryId}.${encodeURIComponent(callId)}`;
}
export function successfulTool(
  entries: readonly EntryRecord[],
  ref: string,
  name: string,
): { args: Record<string, unknown>; details: Record<string, unknown> } | undefined {
  const split = ref.indexOf('.');
  if (split < 1) return;
  const id = Number(ref.slice(0, split));
  if (!Number.isSafeInteger(id) || id <= 0) return;
  let callId: string;
  try {
    callId = decodeURIComponent(ref.slice(split + 1));
  } catch {
    return;
  }
  const entry = entries.find((e) => Number(e.id) === id);
  if (!entry) return;
  const call = entry.model
    ?.flatMap((m) => (m.role === 'assistant' ? m.content : []))
    .find((b) => b.type === 'toolCall' && b.id === callId && b.name === name);
  if (!call || call.type !== 'toolCall') return;
  for (const e of entries) {
    if (Number(e.id) <= id) continue;
    for (const result of e.model ?? []) {
      if (
        result.role === 'toolResult' &&
        !result.isError &&
        result.toolName === name &&
        result.toolCallId === callId &&
        result.details &&
        typeof result.details === 'object' &&
        !Array.isArray(result.details) &&
        (result.details as Record<string, unknown>).ref === ref
      ) {
        return {
          args: call.arguments as Record<string, unknown>,
          details: result.details as Record<string, unknown>,
        };
      }
    }
  }
}
