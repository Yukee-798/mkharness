import {
  ROOT_CONVERSATION_ID,
  type Harness,
  type CommitChange,
  type EntryRecord,
  type TaskRecord,
  type SubmissionRecord,
  type Cursor,
  type Page,
} from '@earendil-works/pi-durable';
import type { ServerContribution, ProjectionContext } from './contributions';
import type { ExtensionState } from '../shared/extension-state';
import { jsonText, type Json as JsonValue } from '../shared/compute';

/** Read-only fold. The host supplies commits through its existing observation subscription. */
export function createExtensionProjection(
  pi: Harness,
  contributions: readonly ServerContribution[],
  requestIds: readonly string[],
  context: Parameters<Harness['inspect']>[0],
) {
  const projectors = contributions.filter((item) => item.projectState);
  const entries = new Map<number, EntryRecord>();
  const tasks = new Map<number, TaskRecord<JsonValue, JsonValue, JsonValue>>();
  const submissions = new Map<number, SubmissionRecord>();
  let cached: ExtensionState | undefined;
  let published = '';
  const accept = (change: CommitChange) => {
    if (change.type === 'entry' && change.value.conversationId === ROOT_CONVERSATION_ID)
      entries.set(Number(change.value.id), change.value);
    else if (change.type === 'task' && change.value.conversationId === ROOT_CONVERSATION_ID)
      tasks.set(Number(change.value.id), change.value);
    else if (change.type === 'submission' && change.value.conversationId === ROOT_CONVERSATION_ID)
      submissions.set(Number(change.value.id), change.value);
    else return false;
    cached = undefined;
    return true;
  };
  const restore = async (
    includeHistory = false,
  ): Promise<ProjectionContext & { page?: Page<EntryRecord, Cursor> }> => {
    if (!projectors.length && !includeHistory) return { entries: [], tasks: [], submissions: [] };
    // One serialized read boundary: older bootstrap pages cannot replace a newer
    // commit. The host subscribes before this read and folds subsequent publications.
    // Native read-only commits have no Storage writes or commit publication.
    return pi.commit(async (tx) => {
      entries.clear();
      tasks.clear();
      submissions.clear();
      let cursor: Cursor | undefined;
      let firstPage: Page<EntryRecord, Cursor> | undefined;
      do {
        const page = await tx.scanEntries(
          { conversationId: ROOT_CONVERSATION_ID, order: 'ascending' },
          100,
          cursor,
        );
        firstPage ??= page;
        for (const entry of page.items) entries.set(Number(entry.id), entry);
        cursor = page.next;
      } while (cursor);
      cursor = undefined;
      do {
        const page = await tx.scanTasks({ conversationId: ROOT_CONVERSATION_ID }, 100, cursor);
        for (const task of page.items) tasks.set(Number(task.id), task);
        cursor = page.next;
      } while (cursor);
      const records = projectors.length
        ? await Promise.all(
            requestIds.map((id) => tx.submissionByRequest(ROOT_CONVERSATION_ID, id)),
          )
        : [];
      for (const submission of records)
        if (submission) submissions.set(Number(submission.id), submission);
      cached = undefined;
      return {
        entries: [...entries.values()],
        tasks: [...tasks.values()],
        submissions: [...submissions.values()],
        page: firstPage,
      };
    }, context);
  };
  const value = (): ExtensionState => {
    if (cached) return cached;
    const context = {
      entries: [...entries.values()],
      tasks: [...tasks.values()],
      submissions: [...submissions.values()],
    };
    const result: ExtensionState = {};
    for (const contribution of projectors) {
      try {
        const value = contribution.projectState!(context);
        // Share the existing 1 MiB finite-JSON budget. A whole conversation's small
        // metadata must not disappear at the per-tool 16 KiB progress threshold.
        jsonText(value);
        result[contribution.id] = value;
      } catch {
        // A broken/oversized optional projection cannot break basic chat or expose raw facts.
        result[contribution.id] = { unavailable: true };
      }
    }
    return (cached = result);
  };
  return {
    restore,
    accept(changes: readonly CommitChange[]) {
      if (!projectors.length) return false;
      let dirty = false;
      for (const change of changes) dirty = accept(change) || dirty;
      return dirty;
    },
    hasChanges: () => JSON.stringify(value()) !== published,
    project() {
      const result = value();
      published = JSON.stringify(result);
      return result;
    },
  };
}
