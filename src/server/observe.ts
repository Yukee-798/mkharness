import { watchEvents, type AgentEvent, type EntryRecord } from '@earendil-works/pi-durable';
import { EventType, type BaseEvent } from '@ag-ui/core';
import { StreamFold, openArgs, toMessages } from '../shared/stream';
import type { ConversationAgent } from './conversation';
import { BG } from './conversation';
import { RemoteIntents, type RemoteIntent } from './remote-example';
import { remoteProgress } from '../shared/remote-progress';
export async function observeRun(
  owner: ConversationAgent,
  runId: string,
  threadId: string,
): Promise<Response> {
  const root = await owner.root(),
    pi = await owner.harness.pi();
  const watch = await watchEvents(pi, root.id, BG);
  let record = await owner.submission(runId);
  if (!record) {
    await watch.stop();
    return Response.json({ error: { code: 'run_not_found' } }, { status: 404 });
  }
  const entries = new Map((await owner.allEntries()).map((e) => [Number(e.id), e]));
  let committedRemote: Record<string, RemoteIntent> | undefined;
  let remoteRevision = 0;
  let sendState: (() => void) | undefined;
  const unsubscribe = pi.subscribeCommits((publication) => {
    for (const change of publication.changes) {
      if (
        change.type === 'document' &&
        change.conversationId === root.id &&
        change.record.kind === 'app.remote-intents'
      ) {
        committedRemote =
          (change.value as { operations: Record<string, RemoteIntent> } | null)?.operations ?? {};
        remoteRevision = Number(publication.seq);
        sendState?.();
      }
    }
  });
  const initialRemote = (await pi.snapshot(RemoteIntents, root.id, BG))?.operations ?? {};
  const fold = new StreamFold();
  // A committed snapshot must update the draft already visible in this observation.
  // Pi entry ids remain authoritative in storage and on the next attachment.
  const liveMessageIds = new Map<string, string>();
  let draft = 0,
    active = false,
    ended = false;
  let textPrefix: string | undefined,
    args = new Map<number, string>();
  let reasoning = new Map<number, { prefix: string; ended: boolean }>();
  let timer: ReturnType<typeof setInterval>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: BaseEvent) => {
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
      const history = () =>
        emit({
          type: EventType.MESSAGES_SNAPSHOT,
          messages: toMessages(
            [...entries.values()].sort((a, b) => Number(a.id) - Number(b.id)),
            liveMessageIds,
          ),
        } as BaseEvent);
      const state = () =>
        emit({
          type: EventType.STATE_SNAPSHOT,
          snapshot: {
            runId,
            status: record!.status,
            stopping: owner.stopping,
            remoteRevision,
            remote: remoteProgress(committedRemote ?? initialRemote),
          },
        } as BaseEvent);
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
      const publish = (complete = false) => {
        if (!fold.current) return;
        // assistant-ui starts a distinct message on TEXT_MESSAGE_START, including rounds
        // containing only reasoning/tools. Start before reasoning so it belongs to this round.
        if (textPrefix === undefined) {
          emit({
            type: EventType.TEXT_MESSAGE_START,
            messageId: `draft:${runId}:${draft}`,
            role: 'assistant',
          } as BaseEvent);
          textPrefix = '';
        }
        // Reasoning is model-provided text, not a synthesized status message. Opaque/redacted
        // blocks and provider signatures stay in Pi history and never enter the browser stream.
        for (const [index, previous] of reasoning) {
          const block = fold.current.content[index];
          if (
            block?.type !== 'thinking' ||
            block.redacted ||
            !block.thinking.startsWith(previous.prefix) ||
            (previous.ended && block.thinking !== previous.prefix)
          ) {
            reset();
            return;
          }
        }
        for (const [index, block] of fold.current.content.entries()) {
          if (block.type !== 'thinking' || block.redacted || !block.thinking.trim()) continue;
          const messageId = `draft:${runId}:${draft}:reasoning:${index}`;
          let previous = reasoning.get(index);
          if (!previous) {
            emit({
              type: EventType.REASONING_MESSAGE_START,
              messageId,
              role: 'reasoning',
            } as BaseEvent);
            previous = { prefix: '', ended: false };
            reasoning.set(index, previous);
          }
          const delta = block.thinking.slice(previous.prefix.length);
          if (delta)
            emit({ type: EventType.REASONING_MESSAGE_CONTENT, messageId, delta } as BaseEvent);
          previous.prefix = block.thinking;
          // Once the next block starts, this reasoning block has finished even if the answer
          // is still streaming. Closing it here keeps the disclosure status truthful.
          if (!previous.ended && (complete || index < fold.current.content.length - 1)) {
            emit({ type: EventType.REASONING_MESSAGE_END, messageId } as BaseEvent);
            previous.ended = true;
          }
        }
        const blocks = fold.current.content.filter((b) => b.type === 'text');
        if (blocks.length) {
          const next = blocks.map((b) => b.text).join('\n');
          if (!next.startsWith(textPrefix)) {
            reset();
            return;
          }
          const delta = next.slice(textPrefix.length);
          if (delta)
            emit({
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: `draft:${runId}:${draft}`,
              delta,
            } as BaseEvent);
          textPrefix = next;
        }
        for (const [index, block] of fold.current.content.entries()) {
          if (block.type === 'toolCall') {
            const callId = `draft:${runId}:${draft}.${encodeURIComponent(block.id)}`;
            if (!args.has(index)) {
              emit({
                type: EventType.TOOL_CALL_START,
                toolCallId: callId,
                toolCallName: block.name,
                parentMessageId: `draft:${runId}:${draft}`,
              } as BaseEvent);
              args.set(index, '');
            }
            const next = complete ? JSON.stringify(block.arguments) : openArgs(block.arguments),
              old = args.get(index)!;
            if (!next.startsWith(old)) {
              reset();
              return;
            }
            const delta = next.slice(old.length);
            if (delta)
              emit({ type: EventType.TOOL_CALL_ARGS, toolCallId: callId, delta } as BaseEvent);
            args.set(index, next);
            if (complete) emit({ type: EventType.TOOL_CALL_END, toolCallId: callId } as BaseEvent);
          }
        }
        if (complete && textPrefix !== undefined)
          emit({
            type: EventType.TEXT_MESSAGE_END,
            messageId: `draft:${runId}:${draft}`,
          } as BaseEvent);
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
          for (const event of events) {
            if (ended) return;
            if (event.type === 'submission' && event.record.id === record!.id) {
              record = event.record;
              state();
              if (terminal()) return;
            } else if (event.type === 'snapshot') {
              reset();
              return;
            } else if (event.type === 'run_start') active = event.inputs.includes(record!.id);
            else if (event.type === 'message_start' && active) {
              draft++;
              textPrefix = undefined;
              args = new Map();
              reasoning = new Map();
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
              history();
            } else if (
              event.type === 'entry_appended' ||
              (event.type === 'tool_execution_end' && event.entry)
            ) {
              const entry = (event as { entry: EntryRecord }).entry;
              entries.set(Number(entry.id), entry);
              history();
            }
          }
        } catch {
          emit({
            type: EventType.RUN_ERROR,
            message: 'Cannot restore the task stream',
            code: 'stream_restore_failed',
          } as BaseEvent);
          close();
        }
      });
      void watch.closed.then(() => {
        if (!ended) {
          emit({
            type: EventType.RUN_ERROR,
            message: 'Observation ended. Reconnect to restore progress.',
            code: 'stream_closed',
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
