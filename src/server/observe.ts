import { watchEvents, type AgentEvent, type EntryRecord } from '@earendil-works/pi-durable';
import { EventType, type BaseEvent, type ToolCallStartEvent } from '@ag-ui/core';
import { StreamFold, DraftProjection, toMessages, toolResultEvent } from '../shared/stream';
import type { ConversationAgent } from './conversation';
import { BG } from './conversation';
import { RemoteIntents, type RemoteIntent } from './remote-example';
import { remoteProgress } from '../shared/remote-progress';
import { compactionIssues } from '../shared/runtime-issues';
import { restoreToolProgress } from './tool-progress';
export async function observeRun(
  owner: ConversationAgent,
  runId: string,
  threadId: string,
): Promise<Response> {
  const root = await owner.root(),
    pi = await owner.harness.pi();
  let record = await owner.submission(runId);
  if (!record) return Response.json({ error: { code: 'run_not_found' } }, { status: 404 });
  let watch = await watchEvents(pi, root.id, BG);
  let progress: Awaited<ReturnType<typeof restoreToolProgress>>;
  let projector: Awaited<ReturnType<ConversationAgent['progressProjector']>>;
  const extensionProjection = await owner.extensionProjection().catch(async (error) => {
    await watch.stop();
    throw error;
  });
  const entries = new Map<number, EntryRecord>();
  let committedRemote: Record<string, RemoteIntent> | undefined;
  let compactionFailure = watch.snapshot.compactionFailure;
  let runtimeChanged = false;
  let remoteRevision = 0;
  let sendState: (() => void) | undefined;
  let stateScheduled = false;
  let remoteChanged = false;
  const unsubscribe = pi.subscribeCommits((publication) => {
    const projectionChanged = extensionProjection.accept(publication.changes);
    for (const change of publication.changes) {
      if (
        change.type === 'document' &&
        change.conversationId === root.id &&
        change.record.kind === 'pi.live'
      ) {
        const next = (change.value as { compactionFailure?: typeof compactionFailure } | null)
          ?.compactionFailure;
        if (next?.taskId !== compactionFailure?.taskId) {
          compactionFailure = next;
          runtimeChanged = true;
        }
      }
      if (
        change.type === 'document' &&
        change.conversationId === root.id &&
        change.record.kind === 'app.remote-intents'
      ) {
        committedRemote =
          (change.value as { operations: Record<string, RemoteIntent> } | null)?.operations ?? {};
        remoteRevision = Number(publication.seq);
        remoteChanged = true;
      }
    }
    // Keep commit listeners short. Coalesce changes and serialize optional public
    // projections outside Pi's synchronous adoption callback, using the same SSE.
    if ((projectionChanged || remoteChanged || runtimeChanged) && !stateScheduled) {
      stateScheduled = true;
      queueMicrotask(() => {
        stateScheduled = false;
        if (!sendState) return;
        if (remoteChanged || runtimeChanged || extensionProjection.hasChanges()) sendState?.();
      });
    }
  });
  try {
    let facts = await extensionProjection.restore(true);
    const latest = await owner.submission(runId);
    if (!latest) {
      unsubscribe();
      await watch.stop();
      return Response.json({ error: { code: 'run_not_found' } }, { status: 404 });
    }
    if (
      record.status !== 'done' &&
      record.status !== 'unanswered' &&
      (latest.status === 'done' || latest.status === 'unanswered')
    ) {
      // Completion can race bootstrap. Acquire a prefix after its receipt;
      // pending work instead continues through the watch's queued events.
      await watch.stop();
      watch = await watchEvents(pi, root.id, BG);
      compactionFailure = watch.snapshot.compactionFailure;
      facts = await extensionProjection.restore(true);
    }
    record = latest;
    for (const entry of facts.entries) entries.set(Number(entry.id), entry);
    progress = await restoreToolProgress(pi, watch.snapshot, facts.entries, facts.tasks);
    projector = await owner.progressProjector();
  } catch (error) {
    unsubscribe();
    await watch.stop();
    throw error;
  }
  const initialRemote =
    (
      await pi.snapshot(RemoteIntents, root.id, BG).catch(async (error) => {
        unsubscribe();
        await watch.stop();
        throw error;
      })
    )?.operations ?? {};
  let queue = await owner.queuedInputs().catch(async (error) => {
    unsubscribe();
    await watch.stop();
    throw error;
  });
  let queueChanged = true;
  const fold = new StreamFold();
  // A committed snapshot must update the draft already visible in this observation.
  // Pi entry ids remain authoritative in storage and on the next attachment.
  const liveMessageIds = new Map<string, string>();
  const emittedToolResults = new Set<string>();
  const streamedToolCalls = new Set<string>();
  let draft = 0,
    active = false,
    ended = false;
  let timer: ReturnType<typeof setInterval>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: BaseEvent) => {
        if (event.type === EventType.TOOL_CALL_START)
          streamedToolCalls.add((event as ToolCallStartEvent).toolCallId);
        if (!ended)
          controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(event) + '\n\n'));
      };
      const close = () => {
        if (ended) return;
        ended = true;
        clearInterval(timer);
        unsubscribe();
        controller.close();
        void watch.stop();
      };
      const history = (completedEntry?: EntryRecord) => {
        const messages = toMessages(
          [...entries.values()].sort((a, b) => Number(a.id) - Number(b.id)),
          liveMessageIds,
        );
        if (completedEntry)
          for (const message of messages)
            if (
              message.role === 'tool' &&
              streamedToolCalls.has(message.toolCallId) &&
              (message.id === String(completedEntry.id) ||
                message.id.startsWith(`${completedEntry.id}:`)) &&
              !emittedToolResults.has(message.id)
            ) {
              emittedToolResults.add(message.id);
              emit(toolResultEvent(message));
            }
        emit({
          type: EventType.MESSAGES_SNAPSHOT,
          messages,
        } as BaseEvent);
      };
      const state = () => {
        remoteChanged = false;
        runtimeChanged = false;
        emit({
          type: EventType.STATE_SNAPSHOT,
          snapshot: {
            runId,
            status: record!.status,
            stopping: owner.stopping,
            ...(queueChanged ? { queue } : {}),
            runtimeIssues: compactionIssues(compactionFailure),
            messageIds: Object.fromEntries(liveMessageIds),
            toolProgress: Object.fromEntries(
              Object.entries(progress.project(projector)).map(([id, value]) => {
                const boundary = id.indexOf('.');
                const alias = liveMessageIds.get(id.slice(0, boundary));
                return [alias ? alias + id.slice(boundary) : id, value];
              }),
            ),
            remoteRevision,
            remote: remoteProgress(committedRemote ?? initialRemote),
            extensionState: extensionProjection.project(),
          },
        } as BaseEvent);
        queueChanged = false;
      };
      sendState = () => {
        if (!ended) state();
      };
      const terminal = () => {
        if (record!.status === 'done') {
          emit({ type: EventType.RUN_FINISHED, threadId, runId } as BaseEvent);
          close();
          return true;
        }
        if (record!.status === 'unanswered') {
          emit({
            type: EventType.RUN_ERROR,
            message: 'Task ended without an answer: ' + record!.reason,
            code: record!.reason,
          } as BaseEvent);
          close();
          return true;
        }
        return false;
      };
      const reset = () => {
        emit({ type: EventType.CUSTOM, name: 'pi.reset', value: { runId } } as BaseEvent);
        close();
      };
      let projection = new DraftProjection(`draft:${runId}:${draft}`, emit);
      const publish = (complete = false) => {
        if (fold.current && !projection.publish(fold.current, complete)) reset();
      };
      const snapshot = (event: Extract<AgentEvent, { type: 'snapshot' }>) => {
        for (const entry of event.entries) entries.set(Number(entry.id), entry);
        active = !!event.run?.inputs.includes(record!.id);
        fold.accept(active ? event : { ...event, generation: undefined });
        history();
        state();
        publish();
      };
      emit({ type: EventType.RUN_STARTED, threadId, runId } as BaseEvent);
      snapshot(watch.snapshot);
      if (terminal()) return;
      timer = setInterval(() => {
        if (!ended) controller.enqueue(new TextEncoder().encode(': heartbeat\n\n'));
      }, 15000);
      watch.start(async (events) => {
        try {
          // Pi emits starts before the assistant entry in the same atomic tool-round commit.
          // Bind the entire batch to its committed assistant entry before processing raw provider IDs.
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
            if (ended) return;
            if (event.type === 'inbox_update') {
              queue = await owner.queuedInputs();
              queueChanged = true;
              state();
            } else if (event.type === 'submission' && event.record.id === record!.id) {
              record = event.record;
              state();
            } else if (
              event.type === 'tool_execution_start' ||
              event.type === 'tool_execution_update' ||
              event.type === 'tool_execution_end'
            ) {
              const callId = progress.resolve(event.toolCallId, event.toolName);
              if (!callId) {
                reset();
                return;
              }
              if (event.type === 'tool_execution_end') {
                progress.end(
                  callId,
                  !!event.entry &&
                    !event.entry.model?.some(
                      (message) => message.role === 'toolResult' && message.isError,
                    ),
                );
                if (event.entry) {
                  entries.set(Number(event.entry.id), event.entry);
                  history(event.entry);
                }
              } else progress.update(callId, event.type === 'tool_execution_update' ? event : {});
              state();
            } else if (event.type === 'snapshot') {
              reset();
              return;
            } else if (event.type === 'run_start') active = event.inputs.includes(record!.id);
            else if (event.type === 'message_start' && active) {
              draft++;
              projection = new DraftProjection(`draft:${runId}:${draft}`, emit);
              fold.accept(event);
              publish();
            } else if (event.type === 'message_update' && active) {
              fold.accept(event);
              publish();
            } else if (event.type === 'message_end' && active) {
              const index = event.entry.model?.findIndex((m) => m.role === 'assistant') ?? -1;
              const message = event.entry.model?.[index];
              if (message?.role === 'assistant') {
                fold.accept({ type: 'message_start', message });
                publish(true);
                liveMessageIds.set(
                  index ? `${event.entry.id}:${index}` : String(event.entry.id),
                  `draft:${runId}:${draft}`,
                );
              }
              fold.current = undefined;
              entries.set(Number(event.entry.id), event.entry);
              state();
              history(event.entry);
            } else if (event.type === 'entry_appended') {
              const entry = (event as { entry: EntryRecord }).entry;
              entries.set(Number(entry.id), entry);
              history(entry);
            }
          }
          // Process every result in the atomic publication before closing on its receipt.
          terminal();
        } catch {
          emit({
            type: EventType.RUN_ERROR,
            message: 'Cannot restore the task stream',
            code: 'stream_restore_failed',
          } as BaseEvent);
          close();
        }
      });
      void watch.closed.then((end) => {
        if (!ended) {
          emit({
            type: EventType.RUN_ERROR,
            message: 'Observation ended. Reconnect to restore progress.',
            code: end.reason === 'session_failed' ? 'runtime_storage_failed' : 'stream_closed',
          } as BaseEvent);
          close();
        }
      });
    },
    cancel() {
      ended = true;
      clearInterval(timer);
      unsubscribe();
      return watch.stop().then(() => {});
    },
  });
  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
