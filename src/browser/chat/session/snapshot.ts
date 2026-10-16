import { request } from '../../api';
import { decodeSnapshot, type ConversationSnapshot } from '../../../shared/conversation';
export type Snapshot = ConversationSnapshot;
export const emptySnapshot: Snapshot = { entries: [], pending: [], stopping: false };
export async function loadSnapshot(id: string, signal?: AbortSignal) {
  const first = decodeSnapshot(
    await request<unknown>(`/conversations/${id}/snapshot?view=window`, { signal }),
  );
  // An older server, or an index still upgrading, retains the original contract.
  let cursor = first.history ? undefined : first.cursor;
  while (cursor) {
    const page = decodeSnapshot(
      await request<unknown>(
        `/conversations/${id}/snapshot?cursor=${encodeURIComponent(JSON.stringify(cursor))}`,
        { signal },
      ),
    );
    first.entries.push(...page.entries);
    cursor = page.cursor;
  }
  return first;
}
