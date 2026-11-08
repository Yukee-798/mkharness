import { traceConversation } from './diagnostics';
import { AbstractAgent, runHttpRequest, transformHttpEventStream } from '@ag-ui/client';
import {
  EventType,
  type RunAgentInput,
  type BaseEvent,
  type CustomEvent,
  type MessagesSnapshotEvent,
  type ToolCallResultEvent,
  type Message,
} from '@ag-ui/core';
import { Observable } from 'rxjs';
import { aliasMessages, messageAliases } from '../../../shared/stream';
import type { ObservationState } from '../../../shared/conversation';
import { conversationRemote, type ConversationRemote } from './remote';
export class StreamReplaced extends Error {}
/** The only run path is GET attach. HTTP submission belongs to the composer. */
export class AttachAgent extends AbstractAgent {
  private messageIds: Map<string, string>;
  constructor(
    private options: {
      conversationId: string;
      finished: () => void;
      connected?: () => void;
      messageIds?: Map<string, string>;
      state?: (runId: string, state: ObservationState) => void;
      target?: () => number | undefined;
      observe?: ConversationRemote['observe'];
      mergeMessages?: (messages: Message[]) => Message[];
    },
  ) {
    super({ threadId: options.conversationId });
    this.messageIds = options.messageIds ?? new Map();
  }
  override clone() {
    return new AttachAgent({ ...this.options, messageIds: this.messageIds });
  }
  run(input: RunAgentInput) {
    return new Observable<BaseEvent>((subscriber) => {
      const config = (
        input.forwardedProps as { runConfig?: { mode?: unknown; runId?: unknown } } | undefined
      )?.runConfig;
      if (config?.mode !== 'attach' || typeof config.runId !== 'string') {
        subscriber.error(new Error('Only attach mode is available'));
        return;
      }
      const controller = new AbortController();
      let terminal = false;
      let lastRevision = -1;
      let references = new Map<string, string>();
      // Live history frames carry only entries added during this observation. Keep the
      // observed window so each frame still imports as one complete, ordered snapshot.
      let observed: Message[] = [];
      input.runId = config.runId;
      const runId = config.runId;
      input.threadId = this.options.conversationId;
      traceConversation('stream.open', { chatId: this.options.conversationId, runId });
      const source = transformHttpEventStream(
        runHttpRequest(() =>
          (this.options.observe ?? conversationRemote.observe)(
            this.options.conversationId,
            runId,
            controller.signal,
            this.options.target?.(),
          ),
        ),
      ).subscribe({
        next: (event) => {
          if (
            [
              EventType.RUN_STARTED,
              EventType.RUN_FINISHED,
              EventType.RUN_ERROR,
              EventType.MESSAGES_SNAPSHOT,
              EventType.TEXT_MESSAGE_START,
              EventType.TOOL_CALL_START,
            ].includes(event.type)
          )
            traceConversation('stream.event', {
              chatId: this.options.conversationId,
              runId,
              type: event.type,
              ...('messageId' in event && typeof event.messageId === 'string'
                ? { messageId: event.messageId.slice(0, 200) }
                : {}),
              ...('toolCallId' in event && typeof event.toolCallId === 'string'
                ? { toolCallId: event.toolCallId.slice(0, 200) }
                : {}),
            });
          if (event.type === EventType.STATE_SNAPSHOT) {
            const state = (event as BaseEvent & { snapshot?: ObservationState }).snapshot;
            if (state?.runId === runId) {
              for (const [canonical, live] of Object.entries(state.messageIds ?? {}))
                if (!this.messageIds.has(canonical)) this.messageIds.set(canonical, live);
              const normalized = { ...state };
              if (state.extensionState) {
                if ((state.extensionStateRevision ?? 0) < lastRevision)
                  delete normalized.extensionState;
                else lastRevision = state.extensionStateRevision ?? 0;
              }
              if (state.toolProgress) {
                const inverse = new Map(
                  Object.entries(state.messageIds ?? {}).map(([canonical, live]) => [
                    live,
                    canonical,
                  ]),
                );
                normalized.toolProgress = Object.fromEntries(
                  Object.entries(state.toolProgress).map(([id, value]) => {
                    const separator = id.indexOf('.');
                    const prefix = id.slice(0, separator);
                    const canonical = inverse.get(prefix) ?? prefix;
                    return [
                      (this.messageIds.get(canonical) ?? canonical) + id.slice(separator),
                      value,
                    ];
                  }),
                );
              }
              this.options.state?.(runId, normalized);
            }
          }
          if (event.type === EventType.MESSAGES_SNAPSHOT) {
            observed = mergeObserved(observed, (event as MessagesSnapshotEvent).messages);
            references = messageAliases(observed, this.messageIds);
            const aliased = aliasMessages(observed, this.messageIds);
            event = {
              ...event,
              messages: this.options.mergeMessages?.(aliased) ?? aliased,
            } as MessagesSnapshotEvent;
          }
          if (event.type === EventType.TOOL_CALL_RESULT) {
            const result = event as ToolCallResultEvent;
            event = {
              ...result,
              toolCallId: references.get(result.toolCallId) ?? result.toolCallId,
            };
          }
          if (event.type === EventType.RUN_STARTED) this.options.connected?.();
          if (event.type === EventType.CUSTOM && (event as CustomEvent).name === 'pi.reset') {
            controller.abort();
            subscriber.error(new StreamReplaced('Stream replaced; restoring current prefix'));
            return;
          }
          if (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR)
            terminal = true;
          subscriber.next(event);
        },
        error: (e) => subscriber.error(e),
        complete: () => {
          if (!terminal) {
            subscriber.error(new Error('Observation disconnected before task settled'));
            return;
          }
          subscriber.complete();
          setTimeout(this.options.finished, 0);
        },
      });
      return () => {
        traceConversation('stream.detach', {
          chatId: this.options.conversationId,
          runId,
          terminal,
        });
        controller.abort();
        source.unsubscribe();
      };
    });
  }
}

const entryOf = (message: Message) => Number(message.id.split(':')[0]);
/** Canonical Pi message IDs start with their entry ID. A frame replaces every observed
 * message from its first entry onward and keeps the older observed prefix. */
export function mergeObserved(observed: readonly Message[], incoming: readonly Message[]) {
  const first = Math.min(...incoming.map(entryOf).filter(Number.isFinite));
  return [...observed.filter((message) => entryOf(message) < first), ...incoming];
}
