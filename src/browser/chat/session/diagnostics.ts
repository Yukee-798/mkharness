/** Bounded, tab-local evidence for the intermittent assistant-ui store failure.
 * Only identifiers and lifecycle counts enter the trace; never prompts, tool arguments or results.
 * Nothing is sent to the server. sessionStorage keeps the captured failure through a refresh.
 */
export const conversationDiagnosticsKey = 'mkharness.conversation-store-errors.v1';
type Detail = Record<string, string | number | boolean | undefined>;
type Trace = { at: string; event: string; detail: Detail };
type Failure = { at: string; route: Detail; stacks: string[]; trace: Trace[] };
const trace: Trace[] = [];
let latest: Failure | undefined;

export function traceConversation(event: string, detail: Detail) {
  if (typeof window === 'undefined') return;
  trace.push({ at: new Date().toISOString(), event, detail });
  if (trace.length > 60) trace.shift();
}
export function isConversationStoreError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes('Entry not available in the store') ||
      (error instanceof AggregateError && error.errors.some(isConversationStoreError)))
  );
}
function stored(): Failure[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(conversationDiagnosticsKey) ?? '[]');
    return Array.isArray(value)
      ? value
          .filter(
            (entry): entry is Failure =>
              !!entry &&
              typeof entry === 'object' &&
              typeof entry.at === 'string' &&
              Array.isArray(entry.stacks) &&
              Array.isArray(entry.trace),
          )
          .slice(-4)
      : [];
  } catch {
    return [];
  }
}
export function recordConversationStoreError(error: unknown) {
  if (typeof window === 'undefined' || !isConversationStoreError(error)) return;
  const stacks = (value: Error): string[] => [
    (value.stack ?? value.message).slice(0, 12000),
    ...(value instanceof AggregateError
      ? value.errors.filter((item): item is Error => isConversationStoreError(item)).flatMap(stacks)
      : []),
  ];
  const search = new URLSearchParams(window.location.search);
  const route: Detail = { path: window.location.pathname };
  for (const key of ['chat', 'scenario', 'view']) {
    const value = search.get(key);
    if (value && /^[a-zA-Z0-9_-]{1,200}$/.test(value)) route[key] = value;
  }
  latest = {
    at: new Date().toISOString(),
    route,
    stacks: stacks(error as Error).slice(0, 5),
    trace: [...trace],
  };
  try {
    sessionStorage.setItem(
      conversationDiagnosticsKey,
      JSON.stringify([...stored(), latest].slice(-4)),
    );
  } catch {
    // A denied/full storage area must not replace the original error.
  }
  console.error('[mkharness:conversation-store]', latest);
}
export function conversationDiagnostics() {
  const failures = stored();
  if (latest && !failures.some((failure) => failure.at === latest!.at)) failures.push(latest);
  return JSON.stringify({ version: 1, failures: failures.slice(-4) }, null, 2);
}
