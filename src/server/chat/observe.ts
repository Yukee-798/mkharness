import { EventType, type BaseEvent, type ToolCallStartEvent } from '@ag-ui/core';
import { DraftProjection, toMessages, toolResultEvent } from '../../shared/stream';
import type { ChatReadFrame, ConversationReadModel } from './read-model';

/** Transport only: native reads, recovery and bounded buffering belong to ReadModel. */
export async function observeRun(
  source: ConversationReadModel,
  runId: string,
  threadId: string,
): Promise<Response> {
  const opened = await source.open(runId);
  if (!opened) return Response.json({ error: { code: 'run_not_found' } }, { status: 404 });
  let ended = false;
  let demand: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const streamedToolCalls = new Set<string>();
      const emittedToolResults = new Set<string>();
      let draft: DraftProjection | undefined;
      const emit = (event: BaseEvent) => {
        if (ended) return;
        if (event.type === EventType.TOOL_CALL_START)
          streamedToolCalls.add((event as ToolCallStartEvent).toolCallId);
        controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(event) + '\n\n'));
      };
      const close = () => {
        if (ended) return;
        ended = true;
        demand?.();
        clearInterval(timer);
        controller.close();
        void opened.close();
      };
      const reset = () => {
        emit({ type: EventType.CUSTOM, name: 'pi.reset', value: { runId } } as BaseEvent);
        close();
      };
      const frame = (value: ChatReadFrame) => {
        if (ended) return;
        if (value.type === 'history') {
          const messages = toMessages(value.entries, new Map(Object.entries(value.aliases)));
          if (value.completedEntryId !== undefined)
            for (const message of messages)
              if (
                message.role === 'tool' &&
                streamedToolCalls.has(message.toolCallId) &&
                (message.id === String(value.completedEntryId) ||
                  message.id.startsWith(`${value.completedEntryId}:`)) &&
                !emittedToolResults.has(message.id)
              ) {
                emittedToolResults.add(message.id);
                emit(toolResultEvent(message));
              }
          emit({ type: EventType.MESSAGES_SNAPSHOT, messages } as BaseEvent);
        } else if (value.type === 'state')
          emit({ type: EventType.STATE_SNAPSHOT, snapshot: value.state } as BaseEvent);
        else if (value.type === 'draft') {
          if (draft?.messageId !== value.messageId)
            draft = new DraftProjection(value.messageId, emit);
          if (!draft.publish(value.message, value.complete)) reset();
        } else if (value.type === 'terminal') {
          if (value.status === 'done')
            emit({ type: EventType.RUN_FINISHED, threadId, runId } as BaseEvent);
          else
            emit({
              type: EventType.RUN_ERROR,
              code: value.reason,
              message: 'Task ended without an answer: ' + value.reason,
            } as BaseEvent);
          close();
        } else if (value.type === 'error') {
          emit({
            type: EventType.RUN_ERROR,
            code: value.code,
            message: value.message,
          } as BaseEvent);
          close();
        } else reset();
      };
      emit({ type: EventType.RUN_STARTED, threadId, runId } as BaseEvent);
      for (const value of opened.initial) frame(value);
      if (ended) return;
      timer = setInterval(() => {
        if (!ended && (controller.desiredSize ?? 0) > 0)
          controller.enqueue(new TextEncoder().encode(': heartbeat\n\n'));
      }, 15000);
      void (async () => {
        try {
          for await (const batch of opened.frames)
            for (const value of batch) {
              if (ended) return;
              if ((controller.desiredSize ?? 0) <= 0)
                await new Promise<void>((resolve) => {
                  demand = resolve;
                });
              if (ended) return;
              frame(value);
            }
        } catch {
          emit({
            type: EventType.RUN_ERROR,
            code: 'stream_restore_failed',
            message: 'Cannot restore the task stream',
          } as BaseEvent);
        } finally {
          close();
        }
      })();
    },
    pull() {
      demand?.();
      demand = undefined;
    },
    cancel() {
      ended = true;
      demand?.();
      clearInterval(timer);
      return opened.close();
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
