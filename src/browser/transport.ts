import { AbstractAgent, runHttpRequest, transformHttpEventStream } from '@ag-ui/client';
import {
  EventType,
  type RunAgentInput,
  type BaseEvent,
  type CustomEvent,
  type MessagesSnapshotEvent,
  type ToolCallResultEvent,
} from '@ag-ui/core';
import { Observable } from 'rxjs';
import type { RemoteProgress } from '../shared/remote-progress';
import { aliasMessages, messageAliases } from '../shared/stream';
import type { ToolProgressMap } from '../shared/tool-progress';
import type { RuntimeIssue } from '../shared/runtime-issues';
import type { ExtensionState } from '../shared/extension-state';
export class StreamReplaced extends Error {}
/** The only run path is GET attach. HTTP submission belongs to the composer. */
export class AttachAgent extends AbstractAgent {
  constructor(
    private conversationId: string,
    private finished: () => void,
    private replaced: () => void,
    private connected: () => void = () => {},
    private progress: (runId: string, value: RemoteProgress[]) => void = () => {},
    private messageIds = new Map<string, string>(),
    private toolProgress: (runId: string, value: ToolProgressMap) => void = () => {},
    private extensionState: (runId: string, value: ExtensionState) => void = () => {},
    private runtimeIssues: (runId: string, value: RuntimeIssue[]) => void = () => {},
  ) {
    super({ threadId: conversationId });
  }
  override clone() {
    return new AttachAgent(
      this.conversationId,
      this.finished,
      this.replaced,
      this.connected,
      this.progress,
      this.messageIds,
      this.toolProgress,
      this.extensionState,
      this.runtimeIssues,
    );
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
      input.runId = config.runId;
      const runId = config.runId;
      input.threadId = this.conversationId;
      const source = transformHttpEventStream(
        runHttpRequest(() =>
          fetch(
            `/api/conversations/${encodeURIComponent(this.conversationId)}/runs/${encodeURIComponent(runId)}/events`,
            { signal: controller.signal, headers: { Accept: 'text/event-stream' } },
          ),
        ),
      ).subscribe({
        next: (event) => {
          if (event.type === EventType.STATE_SNAPSHOT) {
            const state = (
              event as BaseEvent & {
                snapshot?: {
                  runId?: string;
                  remoteRevision?: number;
                  remote?: RemoteProgress[];
                  messageIds?: Record<string, string>;
                  toolProgress?: ToolProgressMap;
                  extensionState?: ExtensionState;
                  runtimeIssues?: RuntimeIssue[];
                };
              }
            ).snapshot;
            if (state?.runId === runId && state.messageIds)
              for (const [canonicalId, liveId] of Object.entries(state.messageIds))
                if (!this.messageIds.has(canonicalId)) this.messageIds.set(canonicalId, liveId);
            if (state?.runId === runId && Array.isArray(state.runtimeIssues))
              this.runtimeIssues(runId, state.runtimeIssues);
            if (state?.runId === runId && state.extensionState)
              this.extensionState(runId, state.extensionState);
            if (state?.runId === runId && state.toolProgress) {
              const inverse = new Map(
                Object.entries(state.messageIds ?? {}).map(([canonical, live]) => [
                  live,
                  canonical,
                ]),
              );
              this.toolProgress(
                runId,
                Object.fromEntries(
                  Object.entries(state.toolProgress).map(([id, value]) => {
                    const boundary = id.indexOf('.');
                    const prefix = id.slice(0, boundary);
                    const canonical = inverse.get(prefix) ?? prefix;
                    return [
                      (this.messageIds.get(canonical) ?? canonical) + id.slice(boundary),
                      value,
                    ];
                  }),
                ),
              );
            }
            if (
              state?.runId === runId &&
              Array.isArray(state.remote) &&
              typeof state.remoteRevision === 'number' &&
              state.remoteRevision >= lastRevision
            ) {
              lastRevision = state.remoteRevision;
              this.progress(runId, state.remote);
            }
          }
          if (event.type === EventType.MESSAGES_SNAPSHOT) {
            references = messageAliases((event as MessagesSnapshotEvent).messages, this.messageIds);
            event = {
              ...event,
              messages: aliasMessages((event as MessagesSnapshotEvent).messages, this.messageIds),
            } as MessagesSnapshotEvent;
          }
          if (event.type === EventType.TOOL_CALL_RESULT) {
            const result = event as ToolCallResultEvent;
            event = {
              ...result,
              toolCallId: references.get(result.toolCallId) ?? result.toolCallId,
            };
          }
          if (event.type === EventType.RUN_STARTED) this.connected();
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
          setTimeout(this.finished, 0);
        },
      });
      return () => {
        controller.abort();
        source.unsubscribe();
      };
    });
  }
}
