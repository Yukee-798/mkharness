import { useEffect, useMemo, useState, useRef } from 'react';
import { fromThreadMessageLike } from '@assistant-ui/react';
import { useAgUiRuntime, fromAgUiMessages } from '@assistant-ui/react-ag-ui';
import { toMessages } from '../../../shared/stream';
import { browserUserContent } from '../../../shared/images';
import { useExtensionConfig } from '../../extensions/extension-config';
import { imageAttachmentAdapter } from '../image-attachments';
import { AttachAgent, StreamReplaced } from './transport';
import type { useSubmission } from './use-submission';
import type { RuntimeIssue } from '../../../shared/runtime-issues';
import type { ToolProgressMap } from '../../../shared/tool-progress';
import type { ExtensionState } from '../../../shared/extension-state';
import type { QueuedInput } from '../../../shared/queue';
import type { Snapshot } from './snapshot';
import type { ConversationHistory } from './history-store';
export function useConversationRuntime({
  id,
  userId,
  snapshot,
  initialSubmission,
  restoration,
  done,
  reconnect,
  connected,
  queue,
  historyStore,
  prependVersion,
}: {
  id: string;
  userId: string;
  snapshot: Snapshot;
  initialSubmission?: ReturnType<typeof useSubmission>['latest'];
  restoration: number;
  done: () => void;
  reconnect: (replacement?: boolean) => void;
  connected: () => void;
  queue: (value: QueuedInput[]) => void;
  historyStore: ConversationHistory;
  prependVersion: number;
}) {
  const extensions = useExtensionConfig(userId);
  const [runtimeIssues, setRuntimeIssues] = useState<RuntimeIssue[]>(snapshot.runtimeIssues ?? []);
  const [toolProgress, setToolProgress] = useState<ToolProgressMap>(snapshot.toolProgress ?? {});
  const [, updateAnnotations] = useState(0);
  const [extensionState, setExtensionState] = useState<ExtensionState>(
    snapshot.extensionState ?? {},
  );
  // Commit aliases belong to this runtime only. Fresh mounts restore canonical Pi IDs.
  const messageIds = useMemo(() => new Map<string, string>(), []);
  const optimistic =
    !snapshot.pending.length &&
    !snapshot.entries.some((e) => e.model?.some((m) => m.role === 'user'))
      ? initialSubmission?.submission
      : undefined;
  const history = useMemo(() => {
    const source = toMessages(snapshot.entries, messageIds);
    // This is the first message of a just-created chat. Once Pi exposes a user
    // entry (or accepted work), its history takes over without text-based matching.
    if (optimistic)
      source.push({
        id: `submitting:${optimistic.command.runId}`,
        role: 'user',
        content: browserUserContent(optimistic.command.text, optimistic.command.images),
      });
    const messages = fromAgUiMessages(source, {
      showThinking: true,
    }).map((m) => fromThreadMessageLike(m, m.id!, { type: 'complete', reason: 'stop' }));
    return {
      messages: messages.map((message, i) => ({
        parentId: i ? messages[i - 1].id : null,
        message,
      })),
      headId: messages.at(-1)?.id ?? null,
    };
  }, [snapshot.entries, messageIds, optimistic]);
  const callbacks = useRef({ done, reconnect, connected, queue, snapshot });
  callbacks.current = { done, reconnect, connected, queue, snapshot };
  const agent = useMemo(
    () =>
      new AttachAgent({
        conversationId: id,
        finished: () => callbacks.current.done(),
        connected: () => callbacks.current.connected(),
        messageIds,
        window: () => !!callbacks.current.snapshot.history,
        mergeMessages: (messages) => historyStore.mergeMessages(messages, messageIds),
        state: (runId, value) => {
          const pending = callbacks.current.snapshot.pending;
          const active = pending.find((item) => item.status === 'running') ?? pending[0];
          if (active?.operationId !== runId) return;
          if (value.toolProgress)
            setToolProgress((previous) => ({ ...previous, ...value.toolProgress }));
          if (value.extensionState) setExtensionState(value.extensionState);
          if (value.runtimeIssues)
            setRuntimeIssues([
              ...(callbacks.current.snapshot.runtimeIssues ?? []).filter(
                (issue) => issue.code !== 'compaction_failed',
              ),
              ...value.runtimeIssues,
            ]);
          if (value.queue) callbacks.current.queue(value.queue);
          if (value.history) {
            historyStore.accept(value.history);
            updateAnnotations((version) => version + 1);
          }
        },
      }),
    [id, messageIds, historyStore],
  );
  const runtime = useAgUiRuntime({
    agent,
    adapters: { attachments: imageAttachmentAdapter },
    showThinking: true,
    autoCancelPendingToolCalls: false,
    onError: (e) => callbacks.current.reconnect(e instanceof StreamReplaced),
  });
  const activeRunId = (snapshot.pending.find((p) => p.status === 'running') ?? snapshot.pending[0])
    ?.operationId;
  const previousPrepend = useRef(prependVersion);
  const windowed = !!snapshot.history;
  useEffect(() => {
    let imported = history;
    const prepending = previousPrepend.current !== prependVersion;
    if (windowed) {
      const current = runtime.thread.export();
      const inverse = new Map([...messageIds].map(([canonical, live]) => [live, canonical]));
      const position = (id: string) => Number((inverse.get(id) ?? id).split(':')[0]);
      // A long run may commit more than one window. Keep committed messages already
      // rendered by SSE, while an obsolete uncommitted draft is still dropped on reset.
      const retained = current.messages.filter(
        (item) => Number.isFinite(position(item.message.id)) || prepending,
      );
      if (retained.length) {
        const messages = new Map(retained.map((item) => [item.message.id, item.message]));
        for (const item of history.messages) messages.set(item.message.id, item.message);
        const merged = [...messages.values()].sort(
          (a, b) => (position(a.id) || Infinity) - (position(b.id) || Infinity),
        );
        imported = {
          messages: merged.map((message, index) => ({
            message,
            parentId: index ? merged[index - 1]!.id : null,
          })),
          headId: merged.at(-1)?.id ?? null,
        };
      }
    }
    previousPrepend.current = prependVersion;
    runtime.thread.import(imported);
  }, [runtime, history, prependVersion, windowed, messageIds]);
  useEffect(() => {
    if (activeRunId)
      void runtime.thread.resumeRun({
        parentId: runtime.thread.export().headId ?? null,
        runConfig: { custom: { mode: 'attach', runId: activeRunId } },
      });
    // Detaching a view is not a durable cancel; history pagination never resumes a run.
  }, [runtime, activeRunId, restoration]);
  return {
    runtime,
    extensions,
    messageIds,
    activeRunId,
    runtimeIssues: activeRunId ? runtimeIssues : (snapshot.runtimeIssues ?? []),
    toolProgress: { ...snapshot.toolProgress, ...(activeRunId ? toolProgress : {}) },
    extensionState: activeRunId ? extensionState : (snapshot.extensionState ?? {}),
    annotations: historyStore.accept(snapshot.history),
  };
}
