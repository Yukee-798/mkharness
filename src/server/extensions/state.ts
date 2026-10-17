import type {
  Harness,
  ConversationId,
  CommitChange,
  EntryRecord,
  TaskRecord,
  SubmissionRecord,
  JsonObject,
} from '@earendil-works/pi-durable';
import type { ServerContribution, ProjectionContext } from './contributions';
import type { ExtensionState } from '../../shared/extension-state';
import type { HistoryAnnotations } from '../../shared/conversation';
import { jsonText, type Json as JsonValue } from '../../shared/json';

/** Page facts and declared documents only. The caller owns the commit subscription. */
export function createExtensionProjection(
  pi: Harness,
  target: ConversationId,
  contributions: readonly ServerContribution[],
  context: Parameters<Harness['inspect']>[0],
  source: {
    restore: (documents: NonNullable<ProjectionContext['documents']>) => Promise<ProjectionContext>;
  },
) {
  const projectors = contributions.filter(
    (item) => item.projectHistory || item.projectConversation,
  );
  const entries = new Map<number, EntryRecord>();
  const tasks = new Map<number, TaskRecord<JsonValue, JsonValue, JsonValue>>();
  const submissions = new Map<number, SubmissionRecord>();
  const documentTokens = new Map(
    projectors.flatMap((item) =>
      (item.stateDocuments ?? []).map((token) => [token.definition.kind, token] as const),
    ),
  );
  const documents = new Map<string, Readonly<JsonObject> | null>();
  const documentVersions = new Map<string, number>();
  let cached: ExtensionState | undefined;
  let restoring: CommitChange[] | undefined;
  const facts = (): ProjectionContext => ({
    entries: [...entries.values()].sort((left, right) => Number(left.id) - Number(right.id)),
    tasks: [...tasks.values()],
    submissions: [...submissions.values()],
    documents,
  });
  const accept = (change: CommitChange) => {
    if (
      change.type === 'entry' &&
      (change.value.conversationId === target || entries.has(Number(change.value.id)))
    )
      entries.set(Number(change.value.id), change.value);
    else if (
      change.type === 'task' &&
      (change.value.conversationId === target || tasks.has(Number(change.value.id)))
    )
      tasks.set(Number(change.value.id), change.value);
    else if (
      change.type === 'submission' &&
      (change.value.conversationId === target || submissions.has(Number(change.value.id)))
    )
      submissions.set(Number(change.value.id), change.value);
    else if (
      change.type === 'document' &&
      change.conversationId === target &&
      documentTokens.has(change.record.kind)
    ) {
      documents.set(change.record.kind, change.value);
      documentVersions.set(change.record.kind, (documentVersions.get(change.record.kind) ?? 0) + 1);
    } else return false;
    cached = undefined;
    return true;
  };
  const restore = async (): Promise<ProjectionContext> => {
    restoring = [];
    try {
      for (const [kind, token] of documentTokens) {
        const version = documentVersions.get(kind);
        const value = await pi.snapshot(token, target, context);
        if (documentVersions.get(kind) === version) documents.set(kind, value ?? null);
      }
      const baseline = await source.restore(documents);
      entries.clear();
      tasks.clear();
      submissions.clear();
      for (const entry of baseline.entries) entries.set(Number(entry.id), entry);
      for (const task of baseline.tasks) tasks.set(Number(task.id), task);
      for (const item of baseline.submissions) submissions.set(Number(item.id), item);
      for (const change of restoring) accept(change);
      cached = undefined;
      return facts();
    } finally {
      restoring = undefined;
    }
  };
  const value = (): ExtensionState => {
    if (cached) return cached;
    const result: ExtensionState = {};
    const current = facts();
    for (const contribution of projectors) {
      if (!contribution.projectConversation) continue;
      try {
        const projected = contribution.projectConversation(current);
        jsonText(projected);
        result[contribution.id] = projected;
      } catch {
        result[contribution.id] = { unavailable: true };
      }
    }
    return (cached = result);
  };
  return {
    restore,
    facts,
    annotations(): HistoryAnnotations {
      const result: HistoryAnnotations = {};
      const current = facts();
      for (const contribution of projectors) {
        if (!contribution.projectHistory) continue;
        try {
          const projected = contribution.projectHistory(current);
          jsonText(projected);
          for (const [id, annotation] of Object.entries(projected))
            if (entries.has(Number(id))) (result[id] ??= {})[contribution.id] = annotation;
        } catch {
          /* Optional decoration cannot break chat. */
        }
      }
      return result;
    },
    accept(changes: readonly CommitChange[]) {
      if (!projectors.length) return false;
      let dirty = false;
      for (const change of changes)
        if (accept(change)) {
          restoring?.push(change);
          dirty = true;
        }
      return dirty;
    },
    project: value,
  };
}
