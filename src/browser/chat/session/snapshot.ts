import { request } from '../../api';
import { decodeSnapshot, type ConversationSnapshot } from '../../../shared/conversation';
export type Snapshot = ConversationSnapshot;
// This UI placeholder has no native conversation yet and never passes the wire decoder.
export const emptySnapshot: Snapshot = {
  conversationId: 0,
  entries: [],
  pending: [],
  queue: [],
  queueEdits: [],
  stopping: false,
  history: { upperEntryId: 0, revision: 0, annotations: {} },
};
export async function loadSnapshot(id: string, signal?: AbortSignal, target?: number) {
  return decodeSnapshot(
    await request<unknown>(
      `/conversations/${encodeURIComponent(id)}/snapshot${target === undefined ? '' : '?conversationId=' + target}`,
      { signal },
    ),
  );
}
