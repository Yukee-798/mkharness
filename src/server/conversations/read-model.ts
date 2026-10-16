import {
  ROOT_CONVERSATION_ID,
  watchEvents,
  type Harness,
  type Cursor,
  type EntryId,
} from '@earendil-works/pi-durable';
import type { ModelCatalog, ModelSelection } from '../../shared/model-selection';
import type { QueuedInput } from '../../shared/queue';
import { AppError } from '../../shared/contracts';
import { historyPosition, type HistoryPage, type HistoryWindow } from '../../shared/conversation';
import { browserEntries } from '../../shared/stream';
import { compactionIssues } from '../../shared/runtime-issues';
import { createExtensionProjection } from '../extensions/state';
import {
  restoreToolProgress,
  restoreHistoryToolProgress,
  toolProjector,
} from '../extensions/tool-progress';
import type { ServerContribution } from '../extensions/contributions';
import type { ConversationFactsIndex } from './facts-index';
import { BG } from './context';
import { observeRun } from './observe';

type Projection = ReturnType<typeof createExtensionProjection>;
type ReadSource = {
  pi: () => Promise<Harness>;
  pending: () => Promise<{ operationId: string; status: 'running' | 'queued' }[]>;
  queuedInputs: () => Promise<QueuedInput[]>;
  stopping: () => boolean;
  contributions: () => Promise<readonly ServerContribution[]>;
  legacyProjection: () => Promise<Projection>;
  configuration: () => Promise<{
    modelCatalog: ModelCatalog;
    selection: ModelSelection;
    capabilityIssues: unknown;
  }>;
  index: ConversationFactsIndex;
};

/** Snapshot and observation share bootstrap, facts, projections and cleanup. */
export class ConversationReadModel {
  constructor(private source: ReadSource) {}
  observe(runId: string, threadId: string, window = false) {
    return observeRun(this, runId, threadId, window);
  }
  get stopping() {
    return this.source.stopping();
  }
  queuedInputs() {
    return this.source.queuedInputs();
  }
  private async page(pi: Harness, rawCursor?: string): Promise<HistoryPage> {
    const position = historyPosition(rawCursor);
    return pi.commit(async (tx) => {
      const page = await tx.scanEntries(
        {
          conversationId: ROOT_CONVERSATION_ID,
          order: 'descending',
          ...(position ? { maxEntryId: (position.before - 1) as EntryId } : {}),
        },
        100,
      );
      const entries = [...page.items];
      const upper = position?.upper ?? Number(entries[0]?.id ?? 0);
      if (entries.length) {
        let lower = Number(entries.at(-1)!.id);
        let required = this.source.index.lowerBound(lower, Number(entries[0]!.id));
        // Include the input/result cohort of a completed reply and the leading tool round.
        while (
          lower > required ||
          entries.at(-1)?.model?.some((message) => message.role === 'toolResult')
        ) {
          const older = await tx.scanEntries(
            {
              conversationId: ROOT_CONVERSATION_ID,
              order: 'descending',
              maxEntryId: (lower - 1) as EntryId,
            },
            Math.min(100, Math.max(1, lower - required)),
          );
          if (!older.items.length) break;
          entries.push(...older.items);
          lower = Number(entries.at(-1)!.id);
          required = Math.min(
            required,
            this.source.index.lowerBound(lower, Number(entries[0]!.id)),
          );
        }
      }
      entries.reverse();
      const first = Number(entries[0]?.id ?? 0);
      const hasOlder =
        first > 1 &&
        (
          await tx.scanEntries(
            {
              conversationId: ROOT_CONVERSATION_ID,
              order: 'descending',
              maxEntryId: (first - 1) as EntryId,
            },
            1,
          )
        ).items.length > 0;
      return {
        entries,
        history: {
          upperEntryId: upper,
          revision: this.source.index.revision,
          annotations: {},
          ...(hasOlder ? { olderCursor: JSON.stringify({ v: 1, before: first, upper }) } : {}),
        },
      };
    }, BG);
  }
  private async projection(pi: Harness, page?: HistoryPage) {
    if (!page) return this.source.legacyProjection();
    const contributions = await this.source.contributions();
    // Existing custom projectors retain their full-history semantics until migrated.
    const legacy = contributions.some(
      (item) =>
        item.projectState &&
        !item.projectHistory &&
        !item.projectConversation &&
        item.historyScope !== 'none',
    );
    if (legacy) return this.source.legacyProjection();
    return createExtensionProjection(pi, contributions, [], BG, {
      restore: (documents) =>
        pi.commit(async () => {
          const extra = contributions.flatMap((item) => item.taskReferences?.(documents) ?? []);
          return this.source.index.facts(page.entries, extra);
        }, BG),
    });
  }
  async readHistory(rawCursor?: string): Promise<HistoryPage> {
    const pi = await this.source.pi();
    const page = await this.page(pi, rawCursor);
    const projection = await this.projection(pi, page);
    const facts = await projection.restore(true);
    page.history.annotations = projection.annotations();
    page.toolProgress = restoreHistoryToolProgress(facts.entries, facts.tasks).project(
      toolProjector(await this.source.contributions()),
    );
    page.entries = browserEntries(page.entries);
    return page;
  }
  async snapshot(rawCursor?: string, window = false): Promise<string> {
    const pi = await this.source.pi();
    const pending = await this.source.pending();
    const terminal = await pi.commit(
      (tx) =>
        tx.scanTasks(
          { conversationId: ROOT_CONVERSATION_ID, status: 'terminal', order: 'descending' },
          100,
        ),
      BG,
    );
    const unavailableTasks = terminal.items
      .filter(
        (task) => task.state.status === 'terminal' && task.state.outcome.status === 'orphaned',
      )
      .map((task) => ({ taskId: Number(task.id), code: 'task_definition_unavailable' }));
    if (window && this.source.index.ready) {
      const page = await this.page(pi, rawCursor);
      const projection = await this.projection(pi, page);
      const facts = await projection.restore(true);
      const inspection = await pi.inspect(BG);
      let progress = restoreHistoryToolProgress(facts.entries, facts.tasks);
      let issues = compactionIssues(undefined);
      if (pending.length) {
        const watch = await watchEvents(pi, ROOT_CONVERSATION_ID, BG);
        try {
          progress = await restoreToolProgress(pi, watch.snapshot, facts.entries, facts.tasks);
          issues = compactionIssues(watch.snapshot.compactionFailure);
        } finally {
          await watch.stop();
        }
      }
      return JSON.stringify({
        entries: browserEntries(page.entries),
        history: { ...page.history, annotations: projection.annotations() },
        pending,
        stopping: this.stopping,
        queue: await this.queuedInputs(),
        ...(await this.source.configuration()),
        extensionState: projection.project(),
        toolProgress: progress.project(toolProjector(await this.source.contributions())),
        runtimeIssues: [
          ...unavailableTasks,
          ...inspection.tasks
            .filter((task) => task.state.kind === 'blocked')
            .map((task) => ({
              taskId: Number(task.record.id),
              code: 'task_definition_unavailable',
            })),
          ...issues,
        ],
      });
    }
    let cursor: Cursor | undefined;
    try {
      cursor = rawCursor ? JSON.parse(rawCursor) : undefined;
    } catch {
      throw new AppError(400, 'invalid_cursor');
    }
    const inspection = await pi.inspect(BG);
    let toolProgress, extensionState, history, compactionFailure;
    if (!cursor) {
      const projection = await this.source.legacyProjection();
      const watch = await watchEvents(pi, ROOT_CONVERSATION_ID, BG);
      try {
        compactionFailure = watch.snapshot.compactionFailure;
        const facts = await projection.restore(true);
        history = facts.page;
        toolProgress = (
          await restoreToolProgress(pi, watch.snapshot, facts.entries, facts.tasks)
        ).project(toolProjector(await this.source.contributions()));
        extensionState = projection.project();
      } finally {
        await watch.stop();
      }
    }
    history ??= await pi.commit(
      (tx) =>
        tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order: 'ascending' }, 100, cursor),
      BG,
    );
    return JSON.stringify({
      entries: browserEntries(history.items),
      cursor: history.next,
      toolProgress,
      extensionState,
      pending,
      queue: await this.queuedInputs(),
      stopping: this.stopping,
      ...(await this.source.configuration()),
      runtimeIssues: [...unavailableTasks, ...compactionIssues(compactionFailure)],
      tools: inspection.tasks
        .filter((task) => task.record.kind === 'pi.tool')
        .map((task) => ({ taskId: Number(task.record.id) })),
    });
  }
  /** Own the subscribe/read/recheck protocol before handing the stream to its Adapter. */
  async open(runId: string, window = false) {
    const pi = await this.source.pi();
    let record = await pi.commit((tx) => tx.submissionByRequest(ROOT_CONVERSATION_ID, runId), BG);
    if (!record) return undefined;
    let watch = await watchEvents(pi, ROOT_CONVERSATION_ID, BG);
    let closed = false;
    let unsubscribe = () => {};
    let notify: (() => void) | undefined;
    let scheduled = false;
    let revision = this.source.index.revision;
    let failure = watch.snapshot.compactionFailure;
    let runtimeChanged = false;
    try {
      const page = window && this.source.index.ready ? await this.page(pi) : undefined;
      const projection = await this.projection(pi, page);
      unsubscribe = pi.subscribeCommits((publication) => {
        const changed = projection.accept(publication.changes);
        if (changed) revision = Number(publication.seq);
        for (const change of publication.changes)
          if (
            change.type === 'document' &&
            change.conversationId === ROOT_CONVERSATION_ID &&
            change.record.kind === 'pi.live'
          ) {
            const next = (change.value as { compactionFailure?: typeof failure } | null)
              ?.compactionFailure;
            if (next?.taskId !== failure?.taskId) {
              failure = next;
              runtimeChanged = true;
            }
          }
        if ((changed || runtimeChanged) && !scheduled) {
          scheduled = true;
          queueMicrotask(() => {
            scheduled = false;
            if (!closed && (runtimeChanged || projection.hasChanges())) notify?.();
          });
        }
      });
      let facts = await projection.restore(true);
      const latest = await pi.commit(
        (tx) => tx.submissionByRequest(ROOT_CONVERSATION_ID, runId),
        BG,
      );
      if (!latest) throw new AppError(404, 'run_not_found');
      if (
        !['done', 'unanswered'].includes(record.status) &&
        ['done', 'unanswered'].includes(latest.status)
      ) {
        await watch.stop();
        watch = await watchEvents(pi, ROOT_CONVERSATION_ID, BG);
        failure = watch.snapshot.compactionFailure;
        facts = await projection.restore(true);
      }
      record = latest;
      const progress = await restoreToolProgress(pi, watch.snapshot, facts.entries, facts.tasks);
      const projector = toolProjector(await this.source.contributions());
      const queue = await this.queuedInputs();
      const history = (): HistoryWindow | undefined =>
        page ? { ...page.history, revision, annotations: projection.annotations() } : undefined;
      return {
        watch,
        record,
        progress,
        projector,
        queue,
        entries: page?.entries ?? facts.entries,
        minEntryId: Number(page?.entries[0]?.id ?? 0),
        listen(callback: () => void) {
          notify = callback;
        },
        state: () => {
          runtimeChanged = false;
          return {
            runtimeIssues: compactionIssues(failure),
            extensionStateRevision: revision,
            extensionState: projection.project(),
            ...(page ? { history: history() } : {}),
          };
        },
        close: async () => {
          if (closed) return;
          closed = true;
          notify = undefined;
          unsubscribe();
          await watch.stop();
        },
      };
    } catch (error) {
      closed = true;
      unsubscribe();
      await watch.stop();
      throw error;
    }
  }
}
