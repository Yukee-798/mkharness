import { decodeSnapshot, type ConversationSnapshot } from '../../src/shared/conversation';

type SnapshotFixture = Omit<Partial<ConversationSnapshot>, 'entries' | 'pending' | 'stopping'> & {
  entries: any[];
  pending: ConversationSnapshot['pending'];
  stopping: boolean;
};

/** Build the current transport envelope and fail immediately on an invalid fixture. */
export function snapshotFixture(input: SnapshotFixture): ConversationSnapshot {
  return decodeSnapshot({
    conversationId: 1,
    queue: [],
    queueEdits: [],
    history: {
      upperEntryId: Math.max(0, ...input.entries.map((entry) => entry.id)),
      revision: 0,
      annotations: {},
    },
    ...input,
  });
}
