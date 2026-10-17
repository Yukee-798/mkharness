import type { ConversationId, ConversationRecord, Tx } from '@earendil-works/pi-durable';

/** Read only immutable creator edges on the caller's transaction. Stop crosses
 * background boundaries, so task ownership reduces to conversation ownership:
 * a task and every task it owns always live in the same native conversation.
 * History parent edges deliberately do not participate in cancellation scope.
 */
export function conversationScope(tx: Pick<Tx, 'conversation'>) {
  const records = new Map<ConversationId, Promise<ConversationRecord | undefined>>();
  return async (candidate: ConversationId, roots: ReadonlySet<number>): Promise<boolean> => {
    if (!roots.size) return false;
    const visited = new Set<ConversationId>();
    let current = candidate;
    for (;;) {
      if (roots.has(Number(current))) return true;
      if (visited.has(current)) throw new Error('Native conversation ownership cycle');
      visited.add(current);
      let record = records.get(current);
      if (!record) {
        record = tx.conversation(current);
        records.set(current, record);
      }
      const value = await record;
      if (!value) throw new Error('Native conversation ownership record is missing');
      if (!value.owner) return false;
      current = value.owner.conversationId;
    }
  };
}
