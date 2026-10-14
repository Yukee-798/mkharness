import {
  ImageComposer,
  AddImage,
  MessageImages,
  imageAttachmentAdapter,
} from './image-attachments';
import { browserUserContent } from '../shared/images';
import { useLocale } from './locale';
import { ExtensionContext, useExtensionContext } from './extension-context';
import { useEffect, useMemo, useState, useRef, type ReactNode } from 'react';
import {
  AssistantRuntimeProvider,
  useAuiState,
  ThreadPrimitive,
  MessagePrimitive,
  fromThreadMessageLike,
  groupPartByType,
  type ToolCallMessagePartProps,
  type TextMessagePartProps,
} from '@assistant-ui/react';
import { useAgUiRuntime, fromAgUiMessages } from '@assistant-ui/react-ag-ui';
import type { EntryRecord } from '@earendil-works/pi-durable';
import { toMessages } from '../shared/stream';
import type { RunCommand } from '../shared/contracts';
import { AttachAgent, StreamReplaced } from './transport';
import { ResourceDrafts } from './ResourceDrafts';
import { request, ApiError } from './api';
import { useQuery } from '@tanstack/react-query';
import { userKeys, modelSettingsOptions } from './queries';
import { useSubmission } from './use-submission';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { ChatLoading } from './chat-loading';
import { Alert, AlertDescription } from './ui/alert';
import { MarkdownText } from './markdown-text';
import { Reasoning, ReasoningRoot, ReasoningContent, ReasoningText } from './reasoning.aui';
import { ModelPicker } from './model-picker';
import {
  resolveModelSelection,
  type ModelCatalog,
  type ModelSelection,
} from '../shared/model-selection';
import type { RemoteProgress } from '../shared/remote-progress';
import { TooltipIconButton } from './tooltip-icon-button';
import { ToolActivity } from './tool-activity';
import { useExtensionConfig } from './extension-config';
import { ToolProgressContext } from './tool-progress';
import type { RuntimeIssue } from '../shared/runtime-issues';
import type { ToolProgressMap } from '../shared/tool-progress';
import type { ExtensionState } from '../shared/extension-state';
import { AssistantFooter } from './assistant-footer';
import { ToolGroupRoot, ToolGroupContent } from './tool-group';
import { DisclosureTrigger, disclosureContentClass, TraceLine } from './trace';
import {
  ArrowUp,
  ArrowDown,
  Check,
  MessageSquare,
  Square,
  LoaderCircle,
  Wrench,
  Brain,
} from 'lucide-react';
export type Snapshot = {
  entries: EntryRecord[];
  toolProgress?: ToolProgressMap;
  extensionState?: ExtensionState;
  cursor?: unknown;
  pending: { operationId: string; status: 'running' | 'queued' }[];
  stopping: boolean;
  modelCatalog?: ModelCatalog;
  selection?: ModelSelection;
  remote?: RemoteProgress[];
  runtimeIssues?: RuntimeIssue[];
};
const emptySnapshot: Snapshot = { entries: [], pending: [], stopping: false };
export async function loadSnapshot(id: string, signal?: AbortSignal) {
  const first = await request<Snapshot>(`/conversations/${id}/snapshot`, { signal });
  let cursor = first.cursor;
  while (cursor) {
    const page = await request<Snapshot>(
      `/conversations/${id}/snapshot?cursor=${encodeURIComponent(JSON.stringify(cursor))}`,
      { signal },
    );
    first.entries.push(...page.entries);
    cursor = page.cursor;
  }
  return first;
}
export function Chat({
  id,
  userId,
  onDirectoryChange,
  onUnavailable,
  onCreated,
  onSettings,
  onModelProviderChange,
}: {
  id: string;
  userId: string;
  onDirectoryChange?: () => void;
  onUnavailable?: () => void;
  onCreated?: (id: string) => void;
  onSettings?: (provider?: string) => void;
  onModelProviderChange?: (provider: string | undefined) => void;
}) {
  const { t } = useLocale();
  const unavailable = useRef(onUnavailable);
  unavailable.current = onUnavailable;
  const query = useQuery({
    queryKey: userKeys(userId).snapshot(id),
    queryFn: ({ signal }) => loadSnapshot(id, signal),
    retry: false,
    enabled: !!id,
  });
  const settings = useQuery(modelSettingsOptions(userId));
  const { send, retry: retrySubmission, latest } = useSubmission(userId, id, onCreated);
  const initialSubmission = latest?.submission?.initial ? latest : undefined;
  const [snapshot, setSnapshot] = useState<Snapshot>(),
    [revision, setRevision] = useState(0),
    [restoration, setRestoration] = useState(0),
    [error, setError] = useState<Error>(),
    [text, setText] = useState(''),
    [accepted, setAccepted] = useState<string[]>([]),
    [sending, setSending] = useState(false);
  const retries = useRef(0);
  const draftVersion = useRef(0);
  const [selection, setSelection] = useState<ModelSelection>();
  const [remote, setRemote] = useState<RemoteProgress[]>([]);
  const [remoteSending, setRemoteSending] = useState(false);
  const [stopSending, setStopSending] = useState(false);
  const catalog = settings.data?.modelCatalog ?? snapshot?.modelCatalog;
  const selected = catalog
    ? resolveModelSelection(
        catalog,
        selection ??
          (initialSubmission?.status !== 'success'
            ? initialSubmission?.submission?.command.config
            : undefined) ??
          snapshot?.selection,
      )
    : undefined;
  useEffect(() => {
    onModelProviderChange?.(selected?.provider);
  }, [selected?.provider, onModelProviderChange]);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [connection, setConnection] = useState<'reconnecting' | 'recovered'>();
  useEffect(() => () => clearTimeout(reconnectTimer.current), []);
  useEffect(() => {
    if (connection !== 'recovered') return;
    const timer = setTimeout(() => setConnection(undefined), 3000);
    return () => clearTimeout(timer);
  }, [connection]);
  const { refetch: refetchSnapshot } = query;
  const restoredRevision = useRef(0);
  useEffect(() => {
    // Idle chats must adopt fresh reads after focus or a cached revisit. Active observation and
    // explicit restoration own their history; background reads must not interrupt either one.
    if (
      restoredRevision.current !== revision ||
      !id ||
      !query.isSuccess ||
      !query.data ||
      snapshot?.pending.length ||
      snapshot === query.data
    )
      return;
    setSnapshot(query.data);
    setRemote(query.data.remote ?? []);
  }, [id, revision, query.data, query.isSuccess, snapshot]);
  useEffect(() => {
    if (!id || revision === 0) return;
    let active = true;
    void refetchSnapshot().then(({ data: s, isSuccess }) => {
      // A failed Query refetch retains cached data. Only a successful read may restore
      // history and attach; otherwise cached pending work can form a terminal SSE loop.
      if (!active || !isSuccess || !s) return;
      restoredRevision.current = revision;
      setSnapshot(s);
      setRestoration(revision);
      setRemote(s.remote ?? []);
      setAccepted([]);
      if (!s.pending.length)
        setConnection((previous) => (previous === 'reconnecting' ? 'recovered' : previous));
    });
    return () => {
      active = false;
    };
  }, [id, revision, refetchSnapshot]);
  useEffect(() => {
    const e = query.error;
    if (!e) return;
    setConnection(undefined);
    if (e instanceof ApiError && e.status === 404 && unavailable.current) unavailable.current();
  }, [query.error]);
  // Query owns read errors; keep submission/action errors separate so a successful
  // refetch clears stale read failures without hiding an unconfirmed submission.
  const visibleError =
    error ?? (latest?.status === 'error' ? latest.error : undefined) ?? query.error;
  const credentialRequired =
    visibleError instanceof ApiError && visibleError.code === 'credential_required';
  const submit = async (
    message: string,
    source?: RunCommand['source'],
    images?: RunCommand['images'],
  ) => {
    if (
      !id &&
      (!selected ||
        !settings.data ||
        settings.data.credentials.find((c) => c.provider === selected.provider)?.effectiveSource ===
          'none')
    ) {
      onSettings?.(selected?.provider);
      throw new ApiError(400, 'credential_required', '请先配置所选模型的 Base URL 与 API Key');
    }
    try {
      await send(message, source, selected, images);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'credential_required')
        onSettings?.(selected?.provider);
      throw e;
    }
    if (!id) return;
    onDirectoryChange?.();
    setAccepted((a) => [...a, message]);
    retries.current = 0;
    setError(undefined);
    if (!snapshot?.pending.length) setRevision((r) => r + 1);
  };
  const refresh = () => {
    retries.current = 0;
    setRevision((r) => r + 1);
    onDirectoryChange?.();
  };
  const reconnect = (replacement = false) => {
    if (!replacement && retries.current >= 4) {
      setConnection(undefined);
      setError(new Error('连接已中断。重新连接后可以继续查看回复。'));
      return;
    }
    setConnection('reconnecting');
    const delay = replacement ? 0 : Math.min(500 * 2 ** retries.current++, 4000);
    clearTimeout(reconnectTimer.current);
    reconnectTimer.current = setTimeout(() => setRevision((r) => r + 1), delay);
  };
  const connected = () => {
    setConnection((previous) => (previous === 'reconnecting' ? 'recovered' : undefined));
  };
  const remoteAction = async (action: 'retry_remote' | 'recheck_remote', taskId: number) => {
    if (remoteSending) return;
    setRemoteSending(true);
    try {
      await submit(
        action === 'retry_remote' ? t('重新执行原任务（可能重复执行）') : t('复查原任务'),
        {
          action,
          taskId,
        },
      );
    } catch (e) {
      setError(e as Error);
    } finally {
      setRemoteSending(false);
    }
  };
  useEffect(() => {
    if (!snapshot?.stopping) return;
    const timer = setTimeout(() => setRevision((r) => r + 1), 1000);
    return () => clearTimeout(timer);
  }, [snapshot]);
  // The wrapper uses assistant-ui focus behavior; submission deliberately stays HTTP-only.
  // Calling runtime.send/abort here would replace the live subscription or cancel a durable task.
  const renderedSnapshot = snapshot ?? (!id || initialSubmission ? emptySnapshot : undefined);
  const submitting = sending || latest?.status === 'pending';
  const composerReady = !id || !!renderedSnapshot;
  const hasPending = !!snapshot?.pending.length || accepted.length > 0;
  const isStopping = stopSending || !!snapshot?.stopping;
  const composerVersion = draftVersion.current;
  const footer = (
    <div className="space-y-3">
      {remote
        .filter((o) =>
          [
            'prepared',
            'submitting',
            'waiting',
            'unknown',
            'timeout',
            'cancel_unknown',
            'cancel_failed',
            'cancel_unsupported',
          ].includes(o.status),
        )
        .map((operation) => {
          const blocked = !['prepared', 'submitting', 'waiting'].includes(operation.status);
          const labels: Record<string, string> = {
            prepared: t('正在准备执行…'),
            submitting: t('正在提交请求…'),
            waiting: t('正在等待结果…'),
            unknown: t('结果暂时无法确认'),
            timeout: t('等待已到期，远端可能仍在运行'),
            cancel_unknown: t('已停止本地任务，远端状态尚未确认'),
            cancel_failed: t('已停止本地任务，远端取消未成功'),
            cancel_unsupported: t('已停止本地任务，远端不支持取消'),
          };
          return (
            <div
              key={operation.taskId}
              role="status"
              data-slot="remote-progress"
              className="rounded-lg border px-3 py-2 text-xs text-muted-foreground"
            >
              <p>{labels[operation.status]}</p>
              {blocked && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={remoteSending || !!snapshot?.pending.length || snapshot?.stopping}
                    onClick={() => void remoteAction('recheck_remote', operation.taskId)}
                  >
                    {t('复查原任务')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={remoteSending || !!snapshot?.pending.length || snapshot?.stopping}
                    onClick={() => void remoteAction('retry_remote', operation.taskId)}
                  >
                    {t('重新执行（可能重复执行）')}
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      {accepted.length > 0 && (
        <aside
          aria-label={t('已接受的任务')}
          className="rounded-lg border bg-muted/40 px-3 py-2 text-xs"
        >
          <p className="font-medium">{t('任务已接受，忙碌时按顺序执行')}</p>
          <div className="mt-1 max-h-20 space-y-1 overflow-y-auto text-muted-foreground">
            {accepted.map((message, i) => (
              <p key={i} className="truncate">
                {message}
              </p>
            ))}
          </div>
        </aside>
      )}
      {connection && (
        <div
          role="status"
          data-slot="connection-status"
          data-state={connection}
          className="flex min-h-8 items-center gap-2 rounded-lg border border-border/60 px-3 py-1.5 text-xs text-muted-foreground"
        >
          {connection === 'recovered' ? (
            <Check className="size-3.5 shrink-0 text-emerald-600" aria-hidden="true" />
          ) : (
            <LoaderCircle
              className="size-3.5 shrink-0 motion-safe:animate-spin"
              aria-hidden="true"
            />
          )}
          <span className="flex-1">
            {connection === 'reconnecting' ? t('正在重新连接…') : t('已恢复连接')}
          </span>
          {!!snapshot?.pending.some((p) => p.status === 'queued') && (
            <span className="tabular-nums">
              {t('{count} 项排队', {
                count: snapshot.pending.filter((p) => p.status === 'queued').length,
              })}
            </span>
          )}
        </div>
      )}
      {visibleError && (
        <Alert variant="destructive">
          <AlertDescription>
            {t(visibleError.message)}
            {credentialRequired ? (
              onSettings && (
                <Button variant="outline" size="sm" onClick={() => onSettings(selected?.provider)}>
                  {t('配置模型与 API Key')}
                </Button>
              )
            ) : latest?.status === 'error' ? (
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  setError(undefined);
                  try {
                    await retrySubmission();
                    if (!initialSubmission) refresh();
                  } catch (e) {
                    setError(e as Error);
                  }
                }}
              >
                {t('重试提交')}
              </Button>
            ) : id ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  retries.current = 0;
                  setConnection('reconnecting');
                  setError(undefined);
                  setRevision((r) => r + 1);
                }}
              >
                {t('重新连接')}
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      )}
      <ImageComposer
        className="rounded-2xl border bg-background p-3 shadow-sm transition-shadow focus-within:ring-2 focus-within:ring-ring/20"
        onSubmit={async (images) => {
          if (!composerReady || (!text.trim() && !images?.length) || submitting || isStopping)
            return false;
          const submittedVersion = composerVersion;
          setSending(true);
          try {
            await submit(text, undefined, images);
            if (draftVersion.current === submittedVersion) setText('');
            return true;
          } catch (e) {
            setError(e as Error);
            return false;
          } finally {
            setSending(false);
          }
        }}
      >
        {(hasImages) => (
          <>
            <label htmlFor="message" className="sr-only">
              {t('消息')}
            </label>
            <Textarea
              id="message"
              value={text}
              onChange={(e) => {
                draftVersion.current++;
                setText(e.target.value);
              }}
              rows={2}
              placeholder={t('描述你的问题，或说说你想完成什么')}
              className="max-h-40 min-h-14 resize-none rounded-none border-0 px-1 py-1 text-base shadow-none focus-visible:ring-0 md:text-sm"
              disabled={!composerReady || isStopping}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <AddImage disabled={!composerReady || submitting || isStopping} />
              <div className="min-w-0 flex-1">
                {catalog && selected ? (
                  <ModelPicker
                    catalog={catalog}
                    value={selected}
                    onChange={setSelection}
                    disabled={submitting || isStopping}
                  />
                ) : (
                  <span className="px-1 text-[11px] text-muted-foreground">
                    {t('Shift + Enter 换行')}
                  </span>
                )}
              </div>
              <Button
                type={hasPending || isStopping ? 'button' : 'submit'}
                size="icon"
                className="rounded-full"
                aria-label={
                  isStopping
                    ? t('正在停止…')
                    : submitting
                      ? t('提交中…')
                      : hasPending
                        ? t('停止并撤回排队')
                        : t('发送')
                }
                disabled={
                  !composerReady ||
                  submitting ||
                  isStopping ||
                  (!hasPending && ((!text.trim() && !hasImages) || (!id && settings.isPending)))
                }
                onClick={
                  hasPending
                    ? async () => {
                        setStopSending(true);
                        try {
                          await request(`/conversations/${id}/stop`, { method: 'POST' });
                          refresh();
                        } catch (e) {
                          setError(e as Error);
                        } finally {
                          setStopSending(false);
                        }
                      }
                    : undefined
                }
              >
                {submitting || isStopping ? (
                  <LoaderCircle className="size-4 motion-safe:animate-spin" />
                ) : hasPending ? (
                  <Square className="size-4" />
                ) : (
                  <ArrowUp className="size-4" />
                )}
              </Button>
            </div>
          </>
        )}
      </ImageComposer>
    </div>
  );
  return (
    <ResourceDrafts>
      <div className="chat flex min-h-0 flex-1 flex-col">
        {renderedSnapshot ? (
          <Runtime
            key={`${userId}:${id}`}
            id={id}
            userId={userId}
            snapshot={renderedSnapshot}
            initialSubmission={initialSubmission}
            busy={submitting || hasPending || isStopping}
            restoration={restoration}
            submit={submit}
            done={refresh}
            reconnect={reconnect}
            connected={connected}
            progress={setRemote}
            footer={footer}
          />
        ) : (
          <>
            <ChatLoading />
            <div className="mx-auto w-full max-w-3xl px-4 pb-4">
              {visibleError && (
                <Alert variant="destructive">
                  <AlertDescription>
                    {t(visibleError.message)}
                    <Button variant="outline" size="sm" onClick={refresh}>
                      {t('重新连接')}
                    </Button>
                  </AlertDescription>
                </Alert>
              )}
            </div>
          </>
        )}
      </div>
    </ResourceDrafts>
  );
}
function Runtime({
  id,
  userId,
  snapshot,
  initialSubmission,
  busy,
  restoration,
  submit,
  done,
  reconnect,
  connected,
  progress,
  footer,
}: {
  id: string;
  userId: string;
  snapshot: Snapshot;
  initialSubmission?: ReturnType<typeof useSubmission>['latest'];
  busy: boolean;
  restoration: number;
  submit: (text: string, source?: RunCommand['source']) => Promise<void>;
  done: () => void;
  reconnect: (replacement?: boolean) => void;
  connected: () => void;
  progress: (value: RemoteProgress[]) => void;
  footer: ReactNode;
}) {
  const { t } = useLocale();
  const extensions = useExtensionConfig(userId);
  const [runtimeIssues, setRuntimeIssues] = useState<RuntimeIssue[]>(snapshot.runtimeIssues ?? []);
  const [toolProgress, setToolProgress] = useState<ToolProgressMap>(snapshot.toolProgress ?? {});
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
  const optimisticStatus = optimistic ? initialSubmission?.status : undefined;
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
    }).map((m) =>
      fromThreadMessageLike(
        {
          ...m,
          ...(m.id?.startsWith('submitting:')
            ? { metadata: { custom: { submissionStatus: optimisticStatus } } }
            : {}),
        },
        m.id!,
        { type: 'complete', reason: 'stop' },
      ),
    );
    return {
      messages: messages.map((message, i) => ({
        parentId: i ? messages[i - 1].id : null,
        message,
      })),
      headId: messages.at(-1)?.id ?? null,
    };
  }, [snapshot.entries, messageIds, optimistic, optimisticStatus]);
  const callbacks = useRef({ done, reconnect, connected, progress, snapshot });
  callbacks.current = { done, reconnect, connected, progress, snapshot };
  const agent = useMemo(
    () =>
      new AttachAgent(
        id,
        () => callbacks.current.done(),
        () => callbacks.current.reconnect(),
        () => callbacks.current.connected(),
        (runId, value) => {
          const pending = callbacks.current.snapshot.pending;
          const active = pending.find((p) => p.status === 'running') ?? pending[0];
          if (active?.operationId === runId) callbacks.current.progress(value);
        },
        messageIds,
        (runId, value) => {
          const pending = callbacks.current.snapshot.pending;
          const active = pending.find((item) => item.status === 'running') ?? pending[0];
          if (active?.operationId === runId) setToolProgress(value);
        },
        (runId, value) => {
          const pending = callbacks.current.snapshot.pending;
          const active = pending.find((item) => item.status === 'running') ?? pending[0];
          if (active?.operationId === runId) setExtensionState(value);
        },
        (runId, value) => {
          const pending = callbacks.current.snapshot.pending;
          const active = pending.find((item) => item.status === 'running') ?? pending[0];
          if (active?.operationId === runId)
            setRuntimeIssues([
              ...(callbacks.current.snapshot.runtimeIssues ?? []).filter(
                (issue) => issue.code !== 'compaction_failed',
              ),
              ...value,
            ]);
        },
      ),
    [id, messageIds],
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
  useEffect(() => {
    // Refresh the authoritative Pi entries in place. Their IDs preserve existing message/panel
    // instances; resetting the React runtime here would also reset focus and viewport scrolling.
    runtime.thread.import(history);
    if (activeRunId)
      void runtime.thread.resumeRun({
        parentId: history.headId,
        runConfig: { custom: { mode: 'attach', runId: activeRunId } },
      });
    // Native resume supersedes observation; useAgUiRuntime detaches on unmount.
    // cancelRun is a user action that rolls the unanswered message into the composer,
    // so history refresh must not invoke it.
  }, [runtime, history, activeRunId, restoration]);
  return (
    <AssistantRuntimeProvider runtime={runtime} config={extensions.config}>
      <ToolProgressContext value={activeRunId ? toolProgress : (snapshot.toolProgress ?? {})}>
        <ExtensionContext
          value={{
            id,
            userId,
            submit,
            busy,
            activity: extensions.activity,
            toolkit: extensions.toolkit,
            ui: extensions.ui,
            state: activeRunId ? extensionState : (snapshot.extensionState ?? {}),
            messageIds,
          }}
        >
          <ThreadPrimitive.Root aria-label={t('聊天历史')} className="flex min-h-0 flex-1 flex-col">
            <ThreadPrimitive.Viewport
              data-slot="chat-viewport"
              scrollToBottomOnRunStart={false}
              className="group/viewport relative flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain has-[[data-slot=chat-welcome]]:justify-center-safe has-[[data-slot=chat-welcome]]:py-8"
            >
              <ThreadPrimitive.Empty>
                <div
                  data-slot="chat-welcome"
                  className="mx-auto max-w-md shrink-0 px-6 text-center"
                >
                  <MessageSquare className="mx-auto mb-4 size-6 text-muted-foreground" />
                  <p className="text-xl font-medium tracking-tight">{t('今天想解决什么问题？')}</p>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {t('直接提问，或描述你想比较、计算和调整的内容。')}
                  </p>
                </div>
              </ThreadPrimitive.Empty>
              <div
                data-slot="chat-messages"
                className="mx-auto w-full max-w-3xl shrink-0 px-4 pt-8 pb-6 empty:hidden sm:px-6"
              >
                <ThreadPrimitive.Messages
                  components={{ UserMessage: User, AssistantMessage: Assistant }}
                />
              </div>
              <ThreadPrimitive.ViewportFooter className="sticky bottom-0 z-10 mx-auto mt-auto w-full max-w-3xl shrink-0 bg-background px-4 pt-3 pb-4 group-has-[[data-slot=chat-welcome]]/viewport:static group-has-[[data-slot=chat-welcome]]/viewport:mt-0 group-has-[[data-slot=chat-welcome]]/viewport:pt-6 group-has-[[data-slot=chat-welcome]]/viewport:pb-0 sm:px-6">
                <ThreadPrimitive.ScrollToBottom asChild>
                  <TooltipIconButton
                    tooltip={t('回到最新消息')}
                    className="absolute -top-9 left-1/2 size-8 -translate-x-1/2 rounded-full border bg-background shadow-sm group-has-[[data-slot=chat-welcome]]/viewport:hidden"
                  >
                    <ArrowDown className="size-4" />
                  </TooltipIconButton>
                </ThreadPrimitive.ScrollToBottom>
                {extensions.unavailable && (
                  <Alert className="mb-3">
                    <AlertDescription>
                      {t('部分扩展界面未能加载，基础聊天仍可使用。')}
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={extensions.loading}
                        onClick={extensions.retry}
                      >
                        {t('重试加载')}
                      </Button>
                    </AlertDescription>
                  </Alert>
                )}
                {(activeRunId ? runtimeIssues : (snapshot.runtimeIssues ?? [])).length > 0 && (
                  <Alert>
                    <AlertDescription>
                      {(activeRunId ? runtimeIssues : (snapshot.runtimeIssues ?? [])).some(
                        (issue) => issue.code === 'compaction_failed',
                      )
                        ? t('上下文压缩失败，部分任务可能无法继续。请检查模型配置后再发送请求。')
                        : t('部分任务无法恢复，请联系应用维护者。')}
                    </AlertDescription>
                  </Alert>
                )}
                {footer}
              </ThreadPrimitive.ViewportFooter>
            </ThreadPrimitive.Viewport>
          </ThreadPrimitive.Root>
        </ExtensionContext>
      </ToolProgressContext>
    </AssistantRuntimeProvider>
  );
}

function Tool(part: ToolCallMessagePartProps) {
  return <ToolActivity part={part} />;
}
function AssistantText(part: TextMessagePartProps) {
  const { t } = useLocale();
  if (part.text === '' && part.status.type === 'running')
    return <TraceLine live label={t('正在思考…')} icon={<Brain />} />;
  return <MarkdownText />;
}
// GroupedParts is for adjacent runs; the native clustering primitive is retained
// specifically for non-adjacent parts. Tool calls still use GroupedParts below.
const groupReasoningParts = (parts: readonly { type: string }[]) => {
  const indices = parts.flatMap((part, index) => (part.type === 'reasoning' ? [index] : []));
  return indices.length ? [{ groupKey: 'reasoning', indices }] : [];
};
function AssistantReasoning({ children }: { children?: ReactNode }) {
  const { t } = useLocale();
  const { activity } = useExtensionContext();
  const parts = useAuiState((s) => s.message.parts);
  const running = parts.some((part) => part.type === 'reasoning' && part.status.type === 'running');
  const hasTools = parts.some(
    (part) => part.type === 'tool-call' && activity[part.toolName] !== 'hidden',
  );
  return (
    <ReasoningRoot variant="ghost" streaming={running && !hasTools} className="mb-0">
      <DisclosureTrigger
        icon={<Brain />}
        live={running}
        label={running ? t('正在思考…') : t('思考过程')}
      />
      <ReasoningContent aria-busy={running} className={disclosureContentClass}>
        <ReasoningText className="ps-0">{children}</ReasoningText>
      </ReasoningContent>
    </ReasoningRoot>
  );
}
const reasoningComponents = { Group: AssistantReasoning, Reasoning };
export function Assistant() {
  const { t } = useLocale();
  const content = useAuiState((s) => s.message.content);
  const { activity, toolkit } = useExtensionContext();
  const groupAssistantParts = useMemo(
    () =>
      groupPartByType({
        reasoning: ['group-reasoning'],
        'tool-call': ['group-tool'],
        'standalone-tool-call': [],
        ...Object.fromEntries(
          Object.entries(activity)
            .filter(([, visibility]) => visibility === 'hidden')
            .map(([name]) => [`tool-call:${name}`, []]),
        ),
      }),
    [activity],
  );
  const visible = content.filter(
    (part) => part.type !== 'tool-call' || activity[part.toolName] !== 'hidden',
  );
  const traceTail =
    visible.length > 0 &&
    visible.every(
      (part) =>
        part.type === 'reasoning' ||
        (part.type === 'tool-call' && toolkit[part.toolName]?.display !== 'standalone'),
    );
  return (
    <MessagePrimitive.Root
      data-slot="assistant-message"
      data-trace-tail={traceTail}
      className="group/message mb-6 flex min-w-0 flex-col gap-2 text-sm leading-relaxed wrap-anywhere empty:hidden data-[trace-tail=true]:mb-2 has-[+[data-slot=assistant-message]]:mb-2"
    >
      {/* Non-adjacent reasoning belongs to one stable disclosure per model round.
          GroupedParts intentionally only coalesces adjacent parts, so use the SDK's
          supported clustering primitive here rather than rebuilding a message runtime. */}
      {content.some((part) => part.type === 'reasoning') && (
        <MessagePrimitive.Unstable_PartsGrouped
          groupingFunction={groupReasoningParts}
          components={reasoningComponents}
        />
      )}
      {/* Tool scopes and registered standalone content retain their native identities. */}
      {(['tools', 'content'] as const).map((section) => (
        <MessagePrimitive.GroupedParts
          key={section}
          groupBy={groupAssistantParts}
          indicator={section === 'tools' ? 'empty' : 'never'}
        >
          {({ part, children }) => {
            const target =
              part.type === 'group-reasoning' ||
              part.type === 'reasoning' ||
              part.type === 'indicator'
                ? 'tools'
                : part.type === 'group-tool' ||
                    (part.type === 'tool-call' && toolkit[part.toolName]?.display !== 'standalone')
                  ? 'tools'
                  : 'content';
            if (part.type === 'tool-call' && activity[part.toolName] === 'hidden') return <></>;
            // An empty fragment suppresses the native registered-UI fallback too.
            if (target !== section) return <></>;
            switch (part.type) {
              case 'group-tool':
                // Keep the same ancestry from the first call onward. Switching a lone
                // call's fragment to a disclosure remounts its renderer, loses user
                // state and replays all row entrance animations during streaming.
                return (
                  <ToolGroupRoot variant="ghost" defaultOpen>
                    {part.indices.length > 1 && (
                      <DisclosureTrigger
                        icon={<Wrench />}
                        live={part.status.type === 'running'}
                        label={part.status.type === 'running' ? t('正在调用') : t('已调用')}
                        detail={t('{count} 个工具', { count: part.indices.length })}
                        data-slot="tool-group-trigger"
                      />
                    )}
                    <ToolGroupContent
                      className={`${part.indices.length > 1 ? disclosureContentClass : '[&>div]:mt-0!'} [&>div]:gap-2!`}
                    >
                      {children}
                    </ToolGroupContent>
                  </ToolGroupRoot>
                );
              case 'group-reasoning':
              case 'reasoning':
                return <></>;
              case 'text':
                return <AssistantText {...part} />;
              case 'tool-call':
                return (
                  <MessagePrimitive.PartByIndex
                    index={content.findIndex(
                      (item) => item.type === 'tool-call' && item.toolCallId === part.toolCallId,
                    )}
                    components={{ tools: { Fallback: Tool } }}
                  />
                );
              case 'indicator':
                return <TraceLine live label={t('正在思考…')} icon={<Brain />} />;
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
      ))}
      {!traceTail && <AssistantFooter />}
    </MessagePrimitive.Root>
  );
}
function User() {
  const { t } = useLocale();
  const status = useAuiState((s) => s.message.metadata.custom.submissionStatus);
  return (
    <MessagePrimitive.Root className="mb-8 ml-auto w-fit max-w-[85%] rounded-2xl bg-muted px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap wrap-anywhere">
      <MessageImages />
      <MessagePrimitive.Parts />
      {typeof status === 'string' && (
        <p
          role="status"
          className="mt-2 flex items-center justify-end gap-1 text-xs text-muted-foreground"
        >
          {status === 'pending' && (
            <LoaderCircle className="size-3 motion-safe:animate-spin" aria-hidden="true" />
          )}
          {status === 'pending' ? t('提交中…') : status === 'error' ? t('提交未确认') : t('已提交')}
        </p>
      )}
    </MessagePrimitive.Root>
  );
}
