import {
  watchEvents,
  LiveDoc,
  type Harness,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type SubmissionRecord,
} from '@earendil-works/pi-durable';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { ModelCatalog, ModelSelection } from '../../shared/model-selection';
import type { QueuedInput } from '../../shared/queue';
import { AppError } from '../../shared/contracts';
import {
  encodeHistoryPosition,
  historyPosition,
  type HistoryPage,
  type HistoryWindow,
  type ObservationState,
  type QueueEditRecovery,
} from '../../shared/conversation';
import { browserEntries, StreamFold } from '../../shared/stream';
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

export type ChatReadFrame =
  | {
      type: 'history';
      entries: EntryRecord[];
      aliases: Record<string, string>;
      completedEntryId?: number;
    }
  | {
      type: 'state';
      state: ObservationState & {
        conversationId: number;
        status: SubmissionRecord['status'];
        stopping: boolean;
      };
    }
  | { type: 'draft'; messageId: string; message: AssistantMessage; complete: boolean }
  | { type: 'terminal'; status: 'done' | 'unanswered'; reason?: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'reset' };

type ReadSource = {
  chatId: string;
  target: ConversationId;
  pi: () => Promise<Harness>;
  pending: () => Promise<{ operationId: string; status: 'running' | 'queued' }[]>;
  queuedInputs: () => Promise<QueuedInput[]>;
  queueEdits: (target: ConversationId) => Promise<QueueEditRecovery[]>;
  stopping: () => boolean;
  contributions: () => Promise<readonly ServerContribution[]>;
  configuration: () => Promise<{
    modelCatalog: ModelCatalog;
    selection: ModelSelection;
    capabilityIssues?: unknown;
  }>;
  index: ConversationFactsIndex;
};

/** Reads one explicit native target. No read starts or resumes native execution. */
export class ConversationReadModel {
  constructor(private source: ReadSource) {}
  observe(runId: string, threadId: string) {
    return observeRun(this, runId, threadId);
  }
  private async page(pi: Harness, rawCursor?: string): Promise<HistoryPage> {
    const position = historyPosition(rawCursor, this.source.chatId, Number(this.source.target));
    return pi.commit(async (tx) => {
      const scan = async (max: number | undefined, limit: number) =>
        tx.scanEntries(
          {
            conversationId: this.source.target,
            order: 'descending',
            ...(max === undefined ? {} : { maxEntryId: max as EntryId }),
          },
          limit,
        );
      const page = await scan(position ? position.before - 1 : undefined, 100);
      const entries = [...page.items];
      const upper = position?.upper ?? Number(entries[0]?.id ?? 0);
      if (entries.length) {
        let lower = Number(entries.at(-1)!.id);
        const cohort = async () => {
          const segments = new Map<ConversationId, { min: number; max: number }>();
          for (const entry of entries) {
            const id = Number(entry.id),
              segment = segments.get(entry.conversationId);
            segments.set(entry.conversationId, {
              min: Math.min(segment?.min ?? id, id),
              max: Math.max(segment?.max ?? id, id),
            });
          }
          const bounds = await Promise.all(
            [...segments].map(([owner, range]) =>
              this.source.index.lowerBound(owner, range.min, range.max),
            ),
          );
          return Math.min(lower, ...bounds);
        };
        let required = await cohort();
        while (
          lower > required ||
          entries.at(-1)?.model?.some((message) => message.role === 'toolResult')
        ) {
          const older = await scan(lower - 1, Math.min(100, Math.max(1, lower - required)));
          if (!older.items.length) break;
          entries.push(...older.items);
          lower = Number(entries.at(-1)!.id);
          required = Math.min(required, await cohort());
        }
      }
      entries.reverse();
      const first = Number(entries[0]?.id ?? 0);
      const hasOlder = first > 1 && (await scan(first - 1, 1)).items.length > 0;
      return {
        entries,
        history: {
          upperEntryId: upper,
          revision: await this.source.index.revision(),
          annotations: {},
          ...(hasOlder
            ? {
                olderCursor: encodeHistoryPosition({
                  v: 1,
                  chatId: this.source.chatId,
                  conversationId: Number(this.source.target),
                  before: first,
                  upper,
                }),
              }
            : {}),
        },
      };
    }, BG);
  }
  private projection(pi: Harness, page: HistoryPage, contributions: readonly ServerContribution[]) {
    return createExtensionProjection(pi, this.source.target, contributions, BG, {
      restore: (documents) =>
        pi.commit(async () => {
          const extra = contributions.flatMap((item) => item.taskReferences?.(documents) ?? []);
          return this.source.index.facts(this.source.target, page.entries, extra);
        }, BG),
    });
  }
  async readHistory(rawCursor?: string): Promise<HistoryPage> {
    const pi = await this.source.pi(),
      contributions = await this.source.contributions();
    const page = await this.page(pi, rawCursor);
    const projection = this.projection(pi, page, contributions);
    const facts = await projection.restore();
    return {
      entries: browserEntries(page.entries),
      history: { ...page.history, annotations: projection.annotations() },
      toolProgress: restoreHistoryToolProgress(facts.entries, facts.tasks).project(
        toolProjector(contributions),
      ),
    };
  }
  async snapshot(rawCursor?: string): Promise<string> {
    const pi = await this.source.pi(),
      contributions = await this.source.contributions();
    const pending = await this.source.pending();
    const page = await this.page(pi, rawCursor);
    const projection = this.projection(pi, page, contributions);
    const facts = await projection.restore();
    let progress = restoreHistoryToolProgress(facts.entries, facts.tasks);
    const issues = compactionIssues(
      (await pi.snapshot(LiveDoc, this.source.target, BG))?.compactionFailure,
    );
    const inspection = await pi.inspect(BG);
    issues.push(
      ...inspection.tasks
        .filter(
          (task) =>
            task.record.conversationId === this.source.target && task.state.kind === 'blocked',
        )
        .map((task) => ({
          taskId: Number(task.record.id),
          code: 'task_definition_unavailable' as const,
        })),
    );
    if (pending.length) {
      const watch = await watchEvents(pi, this.source.target, BG);
      try {
        progress = await restoreToolProgress(
          pi,
          this.source.target,
          watch.snapshot,
          facts.entries,
          facts.tasks,
        );
      } finally {
        await watch.stop();
      }
    }
    return JSON.stringify({
      conversationId: Number(this.source.target),
      entries: browserEntries(page.entries),
      history: { ...page.history, annotations: projection.annotations() },
      pending,
      stopping: this.source.stopping(),
      queue: await this.source.queuedInputs(),
      queueEdits: await this.source.queueEdits(this.source.target),
      ...(await this.source.configuration()),
      extensionState: projection.project(),
      toolProgress: progress.project(toolProjector(contributions)),
      runtimeIssues: [
        ...facts.tasks
          .filter(
            (task) =>
              task.conversationId === this.source.target &&
              task.state.status === 'terminal' &&
              task.state.outcome.status === 'orphaned',
          )
          .map((task) => ({ taskId: Number(task.id), code: 'task_definition_unavailable' })),
        ...issues,
      ],
    });
  }
  /** Materialize the subscribe/read/recheck protocol before the transport sees any frame. */
  async open(runId: string) {
    const pi = await this.source.pi(),
      target = this.source.target;
    let record = await pi.commit((tx) => tx.submissionByRequest(target, runId), BG);
    if (!record) return undefined;
    let watch = await watchEvents(pi, target, BG);
    let closed = false,
      ready = false,
      scheduled = false,
      finished = false;
    let unsubscribe = () => {};
    let notify: (() => void) | undefined;
    const queued: ChatReadFrame[][] = [];
    let queuedBytes = 0;
    const close = async () => {
      if (closed) return;
      closed = true;
      finished = true;
      unsubscribe();
      notify?.();
      await watch.stop();
    };
    const push = (frames: ChatReadFrame[]) => {
      if (closed || !frames.length) return;
      const bytes = new TextEncoder().encode(JSON.stringify(frames)).byteLength;
      if (queued.length >= 64 || queuedBytes + bytes > 1024 * 1024) {
        queued.splice(0, queued.length, [{ type: 'reset' }]);
        queuedBytes = new TextEncoder().encode(JSON.stringify(queued[0])).byteLength;
        notify?.();
        void close();
        return;
      }
      queued.push(frames);
      queuedBytes += bytes;
      notify?.();
    };
    try {
      const contributions = await this.source.contributions();
      const page = await this.page(pi);
      const projection = this.projection(pi, page, contributions);
      const entries = new Map(page.entries.map((entry) => [Number(entry.id), entry]));
      const aliases = new Map<string, string>();
      let revision = page.history.revision;
      let failure = watch.snapshot.compactionFailure;
      let queue = await this.source.queuedInputs();
      let progress = restoreHistoryToolProgress([], []);
      const projector = toolProjector(contributions);
      const history = (): HistoryWindow => ({
        ...page.history,
        upperEntryId: Math.max(page.history.upperEntryId, ...entries.keys()),
        revision,
        annotations: projection.annotations(),
      });
      const stateFrame = (): ChatReadFrame => ({
        type: 'state',
        state: {
          conversationId: Number(target),
          runId,
          status: record!.status,
          stopping: this.source.stopping(),
          queue,
          runtimeIssues: compactionIssues(failure),
          extensionStateRevision: revision,
          extensionState: projection.project(),
          history: history(),
          messageIds: Object.fromEntries(aliases),
          toolProgress: Object.fromEntries(
            Object.entries(progress.project(projector)).map(([id, value]) => {
              const boundary = id.indexOf('.'),
                alias = aliases.get(id.slice(0, boundary));
              return [alias ? alias + id.slice(boundary) : id, value];
            }),
          ),
        },
      });
      const historyFrame = (completedEntryId?: number): ChatReadFrame => ({
        type: 'history',
        entries: browserEntries([...entries.values()].sort((a, b) => Number(a.id) - Number(b.id))),
        aliases: Object.fromEntries(aliases),
        ...(completedEntryId ? { completedEntryId } : {}),
      });
      const terminal = (): ChatReadFrame | undefined =>
        record!.status === 'done'
          ? { type: 'terminal', status: 'done' }
          : record!.status === 'unanswered'
            ? { type: 'terminal', status: 'unanswered', reason: record!.reason }
            : undefined;
      unsubscribe = pi.subscribeCommits((publication) => {
        let changed = projection.accept(publication.changes);
        if (
          publication.changes.some(
            (change) =>
              (change.type === 'entry' || change.type === 'task' || change.type === 'submission') &&
              change.value.conversationId === target,
          )
        )
          changed = true;
        for (const change of publication.changes)
          if (
            change.type === 'document' &&
            change.conversationId === target &&
            change.record.kind === 'pi.live'
          ) {
            const next = (change.value as { compactionFailure?: typeof failure } | null)
              ?.compactionFailure;
            if (next?.taskId !== failure?.taskId) {
              failure = next;
              changed = true;
            }
          }
        if (changed) revision = Number(publication.seq);
        if (changed && ready && !scheduled) {
          scheduled = true;
          queueMicrotask(() => {
            scheduled = false;
            if (!closed) push([stateFrame()]);
          });
        }
      });
      let facts = await projection.restore();
      const latest = await pi.commit((tx) => tx.submissionByRequest(target, runId), BG);
      if (!latest) throw new AppError(404, 'run_not_found');
      if (
        !['done', 'unanswered'].includes(record.status) &&
        ['done', 'unanswered'].includes(latest.status)
      ) {
        await watch.stop();
        watch = await watchEvents(pi, target, BG);
        failure = watch.snapshot.compactionFailure;
        facts = await projection.restore();
      }
      record = latest;
      for (const entry of facts.entries) entries.set(Number(entry.id), entry);
      const lower = Number(page.entries[0]?.id ?? 0);
      for (const entry of watch.snapshot.entries)
        if (Number(entry.id) >= lower) entries.set(Number(entry.id), entry);
      // A run may finish between the page read and the commit subscription. Rebuild
      // exact locators for the merged native view before publishing terminal state.
      page.entries = [...entries.values()].sort(
        (left, right) => Number(left.id) - Number(right.id),
      );
      facts = await projection.restore();
      progress = await restoreToolProgress(
        pi,
        target,
        watch.snapshot,
        [...entries.values()].sort((a, b) => Number(a.id) - Number(b.id)),
        facts.tasks,
      );
      const fold = new StreamFold();
      let active = !!watch.snapshot.run?.inputs.includes(record.id),
        draft = 0;
      fold.accept(active ? watch.snapshot : { ...watch.snapshot, generation: undefined });
      const initial: ChatReadFrame[] = [historyFrame(), stateFrame()];
      if (fold.current)
        initial.push({
          type: 'draft',
          messageId: `draft:${runId}:${draft}`,
          message: structuredClone(fold.current),
          complete: false,
        });
      const completed = terminal();
      if (completed) {
        initial.push(completed);
        await close();
      } else {
        ready = true;
        watch.start(async (events) => {
          if (closed) return;
          try {
            const frames: ChatReadFrame[] = [];
            for (const event of events)
              if (
                (event.type === 'message_end' || event.type === 'entry_appended') &&
                event.entry.model?.some(
                  (message) =>
                    message.role === 'assistant' &&
                    message.content.some((block) => block.type === 'toolCall'),
                )
              )
                progress.round(event.entry);
            for (const event of events) {
              if (event.type === 'inbox_update') {
                queue = await this.source.queuedInputs();
                frames.push(stateFrame());
              } else if (event.type === 'submission' && event.record.id === record!.id) {
                record = event.record;
                frames.push(stateFrame());
              } else if (
                event.type === 'tool_execution_start' ||
                event.type === 'tool_execution_update' ||
                event.type === 'tool_execution_end'
              ) {
                const call = progress.resolve(event.toolCallId, event.toolName);
                if (!call) {
                  push([{ type: 'reset' }]);
                  await close();
                  return;
                }
                if (event.type === 'tool_execution_end') {
                  progress.end(
                    call,
                    !!event.entry &&
                      !event.entry.model?.some(
                        (message) => message.role === 'toolResult' && message.isError,
                      ),
                  );
                  if (event.entry) {
                    entries.set(Number(event.entry.id), event.entry);
                    frames.push(historyFrame(Number(event.entry.id)));
                  }
                } else progress.update(call, event.type === 'tool_execution_update' ? event : {});
                frames.push(stateFrame());
              } else if (event.type === 'snapshot') {
                push([{ type: 'reset' }]);
                await close();
                return;
              } else if (event.type === 'run_start') active = event.inputs.includes(record!.id);
              else if (
                (event.type === 'message_start' || event.type === 'message_update') &&
                active
              ) {
                if (event.type === 'message_start') draft++;
                fold.accept(event);
                if (fold.current)
                  frames.push({
                    type: 'draft',
                    messageId: `draft:${runId}:${draft}`,
                    message: structuredClone(fold.current),
                    complete: false,
                  });
              } else if (event.type === 'message_end' && active) {
                const offset =
                  event.entry.model?.findIndex((message) => message.role === 'assistant') ?? -1;
                const message = event.entry.model?.[offset];
                if (message?.role === 'assistant') {
                  frames.push({
                    type: 'draft',
                    messageId: `draft:${runId}:${draft}`,
                    message: structuredClone(message),
                    complete: true,
                  });
                  aliases.set(
                    offset ? `${event.entry.id}:${offset}` : String(event.entry.id),
                    `draft:${runId}:${draft}`,
                  );
                }
                fold.current = undefined;
                entries.set(Number(event.entry.id), event.entry);
                frames.push(stateFrame(), historyFrame(Number(event.entry.id)));
              } else if (event.type === 'entry_appended') {
                entries.set(Number(event.entry.id), event.entry);
                frames.push(historyFrame(Number(event.entry.id)));
              }
            }
            const end = terminal();
            if (end) frames.push(end);
            push(frames);
            if (end) await close();
          } catch {
            push([
              {
                type: 'error',
                code: 'stream_restore_failed',
                message: 'Cannot restore the task stream',
              },
            ]);
            await close();
          }
        });
        void watch.closed.then((end) => {
          if (!closed) {
            push([
              {
                type: 'error',
                code: end.reason === 'session_failed' ? 'runtime_storage_failed' : 'stream_closed',
                message: 'Observation ended. Reconnect to restore progress.',
              },
            ]);
            void close();
          }
        });
      }
      const frames: AsyncIterable<readonly ChatReadFrame[]> = {
        async *[Symbol.asyncIterator]() {
          try {
            while (!finished || queued.length) {
              if (!queued.length) {
                await new Promise<void>((resolve) => {
                  notify = resolve;
                });
                continue;
              }
              const batch = queued.shift()!;
              queuedBytes -= new TextEncoder().encode(JSON.stringify(batch)).byteLength;
              yield batch;
            }
          } finally {
            await close();
          }
        },
      };
      return { initial, frames, close };
    } catch (error) {
      await close();
      throw error;
    }
  }
}
