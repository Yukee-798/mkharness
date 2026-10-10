import {
  useEffect,
  useMemo,
  useState,
  useRef,
  createContext,
  useContext,
  type ReactNode,
} from 'react';
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
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
import { AttachAgent, partialUI, StreamReplaced } from './transport';
import { Panel } from './Panel';
import { PanelDrafts } from './PanelDrafts';
import { request, ApiError } from './api';
import { createSubmitter } from './submission';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { ChatLoading } from './chat-loading';
import { Alert, AlertDescription } from './ui/alert';
import { MarkdownText } from './markdown-text';
import { Reasoning, ReasoningRoot, ReasoningContent, ReasoningText } from './reasoning.aui';
import { ModelPicker } from './model-picker';
import type { ModelCatalog, ModelSelection } from '../shared/model-selection';
import { TooltipIconButton } from './tooltip-icon-button';
import { ToolCall } from './tool-call';
import { ToolGroupRoot, ToolGroupContent } from './tool-group';
import { DisclosureTrigger, disclosureContentClass, TraceLine } from './trace';
import {
  ArrowUp,
  ArrowDown,
  Check,
  MessageSquare,
  Square,
  LoaderCircle,
  XCircle,
  CircleMinus,
  AlertCircle,
  Globe,
  Search,
  Wrench,
  Brain,
} from 'lucide-react';
export type Snapshot = {
  entries: EntryRecord[];
  cursor?: unknown;
  pending: { operationId: string; status: 'running' | 'queued' }[];
  stopping: boolean;
  modelCatalog?: ModelCatalog;
  selection?: ModelSelection;
};
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
  onDirectoryChange,
  onUnavailable,
}: {
  id: string;
  onDirectoryChange?: () => void;
  onUnavailable?: () => void;
}) {
  const unavailable = useRef(onUnavailable);
  unavailable.current = onUnavailable;
  const [snapshot, setSnapshot] = useState<Snapshot>(),
    [revision, setRevision] = useState(0),
    [error, setError] = useState(''),
    [text, setText] = useState(''),
    [accepted, setAccepted] = useState<string[]>([]),
    [sending, setSending] = useState(false);
  const retries = useRef(0);
  const [selection, setSelection] = useState<ModelSelection>();
  const selected = selection ?? snapshot?.selection ?? snapshot?.modelCatalog?.defaultSelection;
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [connection, setConnection] = useState<'reconnecting' | 'recovered'>();
  useEffect(() => () => clearTimeout(reconnectTimer.current), []);
  useEffect(() => {
    if (connection !== 'recovered') return;
    const timer = setTimeout(() => setConnection(undefined), 3000);
    return () => clearTimeout(timer);
  }, [connection]);
  useEffect(() => {
    const controller = new AbortController();
    void loadSnapshot(id, controller.signal)
      .then((s) => {
        setSnapshot(s);
        setAccepted([]);
        if (!s.pending.length)
          setConnection((previous) => (previous === 'reconnecting' ? 'recovered' : previous));
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setConnection(undefined);
          if (e instanceof ApiError && e.status === 404 && unavailable.current)
            unavailable.current();
          else setError(e.message);
        }
      });
    return () => controller.abort();
  }, [id, revision]);
  const send = useMemo(
    () =>
      createSubmitter((command) =>
        request(`/conversations/${id}/runs`, { method: 'POST', body: JSON.stringify(command) }),
      ),
    [id],
  );
  const submit = async (message: string, source?: RunCommand['source']) => {
    await send(message, source, selected);
    onDirectoryChange?.();
    setAccepted((a) => [...a, message]);
    retries.current = 0;
    setError('');
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
      setError('连接已中断。重新连接后可以继续查看回复。');
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
  useEffect(() => {
    if (!snapshot?.stopping) return;
    const timer = setTimeout(() => setRevision((r) => r + 1), 1000);
    return () => clearTimeout(timer);
  }, [snapshot]);
  // The wrapper uses assistant-ui focus behavior; submission deliberately stays HTTP-only.
  // Calling runtime.send/abort here would replace the live subscription or cancel a durable task.
  const ComposerRoot = snapshot ? ComposerPrimitive.Root : 'form';
  const footer = (
    <div className="space-y-3">
      {accepted.length > 0 && (
        <aside
          aria-label="已接受的任务"
          className="rounded-lg border bg-muted/40 px-3 py-2 text-xs"
        >
          <p className="font-medium">任务已接受，忙碌时按顺序执行</p>
          <div className="mt-1 max-h-20 space-y-1 overflow-y-auto text-muted-foreground">
            {accepted.map((message, i) => (
              <p key={i} className="truncate">
                {message}
              </p>
            ))}
          </div>
        </aside>
      )}
      {(!!snapshot?.pending.length || connection) && (
        <div
          role="status"
          data-slot="connection-status"
          data-state={snapshot?.stopping ? 'stopping' : (connection ?? 'running')}
          className="flex min-h-8 items-center gap-2 rounded-lg border border-border/60 px-3 py-1.5 text-xs text-muted-foreground"
        >
          {connection === 'recovered' && !snapshot?.stopping ? (
            <Check className="size-3.5 shrink-0 text-emerald-600" aria-hidden="true" />
          ) : (
            <LoaderCircle
              className="size-3.5 shrink-0 motion-safe:animate-spin"
              aria-hidden="true"
            />
          )}
          <span className="flex-1">
            {snapshot?.stopping
              ? '正在停止…'
              : connection === 'reconnecting'
                ? '正在重新连接…'
                : connection === 'recovered'
                  ? '已恢复连接'
                  : '任务运行中'}
          </span>
          {!!snapshot?.pending.some((p) => p.status === 'queued') && (
            <span className="tabular-nums">
              {snapshot.pending.filter((p) => p.status === 'queued').length} 项排队
            </span>
          )}
        </div>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            {error}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                retries.current = 0;
                setConnection('reconnecting');
                setError('');
                setRevision((r) => r + 1);
              }}
            >
              重新连接
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <ComposerRoot
        className="rounded-2xl border bg-background p-3 shadow-sm transition-shadow focus-within:ring-2 focus-within:ring-ring/20"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!text.trim() || sending || snapshot?.stopping) return;
          setSending(true);
          try {
            await submit(text);
            setText('');
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setSending(false);
          }
        }}
      >
        <label htmlFor="message" className="sr-only">
          消息
        </label>
        <Textarea
          id="message"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          placeholder="描述你的问题，或说说你想完成什么"
          className="max-h-40 min-h-14 resize-none rounded-none border-0 px-1 py-1 text-base shadow-none focus-visible:ring-0 md:text-sm"
          disabled={snapshot?.stopping}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            {snapshot?.modelCatalog && selected ? (
              <ModelPicker
                catalog={snapshot.modelCatalog}
                value={selected}
                onChange={setSelection}
                disabled={sending || snapshot.stopping}
              />
            ) : (
              <span className="px-1 text-[11px] text-muted-foreground">Shift + Enter 换行</span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {!!snapshot?.pending.length && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-label="停止并撤回排队"
                disabled={snapshot.stopping}
                onClick={async () => {
                  try {
                    await request(`/conversations/${id}/stop`, { method: 'POST' });
                    refresh();
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                <Square className="size-3" />
                停止
              </Button>
            )}
            <Button
              type="submit"
              size="icon"
              className="rounded-full"
              aria-label={sending ? '提交中…' : '发送'}
              disabled={!text.trim() || sending || snapshot?.stopping}
            >
              {sending ? (
                <LoaderCircle className="size-4 motion-safe:animate-spin" />
              ) : (
                <ArrowUp className="size-4" />
              )}
            </Button>
          </div>
        </div>
      </ComposerRoot>
    </div>
  );
  return (
    <PanelDrafts>
      <div className="chat flex min-h-0 flex-1 flex-col">
        {snapshot ? (
          <Runtime
            id={id}
            snapshot={snapshot}
            submit={submit}
            done={refresh}
            reconnect={reconnect}
            connected={connected}
            footer={footer}
          />
        ) : (
          <>
            <ChatLoading />
            <div className="mx-auto w-full max-w-3xl px-4 pb-4">{footer}</div>
          </>
        )}
      </div>
    </PanelDrafts>
  );
}
function Runtime({
  id,
  snapshot,
  submit,
  done,
  reconnect,
  connected,
  footer,
}: {
  id: string;
  snapshot: Snapshot;
  submit: (text: string, source?: RunCommand['source']) => Promise<void>;
  done: () => void;
  reconnect: (replacement?: boolean) => void;
  connected: () => void;
  footer: ReactNode;
}) {
  const history = useMemo(() => {
    const messages = fromAgUiMessages(toMessages(snapshot.entries), {
      showThinking: true,
    }).map((m) => fromThreadMessageLike(m, m.id!, { type: 'complete', reason: 'stop' }));
    return {
      messages: messages.map((message, i) => ({
        parentId: i ? messages[i - 1].id : null,
        message,
      })),
      headId: messages.at(-1)?.id ?? null,
    };
  }, [snapshot.entries]);
  const callbacks = useRef({ done, reconnect, connected });
  callbacks.current = { done, reconnect, connected };
  const agent = useMemo(
    () =>
      new AttachAgent(
        id,
        () => callbacks.current.done(),
        () => callbacks.current.reconnect(),
        () => callbacks.current.connected(),
      ),
    [id],
  );
  const runtime = useAgUiRuntime({
    agent,
    showThinking: true,
    autoCancelPendingToolCalls: false,
    onError: (e) => callbacks.current.reconnect(e instanceof StreamReplaced),
  });
  useEffect(() => {
    // Refresh the authoritative Pi entries in place. Their IDs preserve existing message/panel
    // instances; resetting the React runtime here would also reset focus and viewport scrolling.
    runtime.thread.import(history);
    const pending = snapshot.pending.find((p) => p.status === 'running') ?? snapshot.pending[0];
    if (pending)
      void runtime.thread.resumeRun({
        parentId: history.headId,
        runConfig: { custom: { mode: 'attach', runId: pending.operationId } },
      });
    // AttachAgent cancellation closes observation only; durable work continues on the server.
    return () => runtime.thread.cancelRun();
  }, [runtime, history, snapshot]);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ChatContext value={{ id, submit }}>
        <ThreadPrimitive.Root aria-label="聊天历史" className="flex min-h-0 flex-1 flex-col">
          <ThreadPrimitive.Viewport
            data-slot="chat-viewport"
            scrollToBottomOnRunStart={false}
            className="relative flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain"
          >
            <ThreadPrimitive.Empty>
              <div className="mx-auto mt-[12vh] max-w-md px-6 text-center">
                <MessageSquare className="mx-auto mb-4 size-6 text-muted-foreground" />
                <p className="text-xl font-medium tracking-tight">今天想解决什么问题？</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  直接提问，或描述你想比较、计算和调整的内容。
                </p>
              </div>
            </ThreadPrimitive.Empty>
            <div
              data-slot="chat-messages"
              className="mx-auto w-full max-w-3xl shrink-0 px-4 pt-8 pb-6 sm:px-6"
            >
              <ThreadPrimitive.Messages
                components={{ UserMessage: User, AssistantMessage: Assistant }}
              />
            </div>
            <ThreadPrimitive.ViewportFooter className="sticky bottom-0 z-10 mx-auto mt-auto w-full max-w-3xl bg-background px-4 pt-3 pb-4 sm:px-6">
              <ThreadPrimitive.ScrollToBottom asChild>
                <TooltipIconButton
                  tooltip="回到最新消息"
                  className="absolute -top-9 left-1/2 size-8 -translate-x-1/2 rounded-full border bg-background shadow-sm"
                >
                  <ArrowDown className="size-4" />
                </TooltipIconButton>
              </ThreadPrimitive.ScrollToBottom>
              {footer}
            </ThreadPrimitive.ViewportFooter>
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>
      </ChatContext>
    </AssistantRuntimeProvider>
  );
}

const ChatContext = createContext<{
  id: string;
  submit: (text: string, source?: RunCommand['source']) => Promise<void>;
} | null>(null);
function Tool(part: ToolCallMessagePartProps) {
  const { id, submit } = useContext(ChatContext)!;
  if (part.toolName === 'prepare_program') return null;
  if (part.toolName === 'present_openui') {
    const preview =
      typeof part.args?.ui === 'string' ? part.args.ui : partialUI(part.argsText ?? '');
    let result = part.result;
    if (typeof result === 'string') {
      try {
        result = JSON.parse(result);
      } catch {
        result = undefined;
      }
    }
    const reference =
      result && typeof result === 'object' && 'panelRef' in result ? result.panelRef : undefined;
    const panelRef = typeof reference === 'string' ? reference : undefined;
    if (part.isError) return null;
    return (
      <>
        {(panelRef || preview) && (
          <Panel
            key={panelRef ?? part.toolCallId}
            conversationId={id}
            panelRef={panelRef}
            preview={preview}
            submit={submit}
          />
        )}
      </>
    );
  }
  return <ToolActivity part={part} />;
}
function ToolActivity({ part }: { part: ToolCallMessagePartProps }) {
  const [open, setOpen] = useState(false);
  const names: Record<string, { active: string; complete: string; failed: string }> = {
    read_web: { active: '正在读取网页', complete: '已读取网页', failed: '网页读取失败' },
    read_webpage: { active: '正在读取网页', complete: '已读取网页', failed: '网页读取失败' },
    search_web: { active: '正在搜索网页', complete: '已搜索网页', failed: '网页搜索失败' },
  };
  const name = names[part.toolName] ?? {
    active: `正在执行：${part.toolName}`,
    complete: `已完成：${part.toolName}`,
    failed: `执行失败：${part.toolName}`,
  };
  const running = part.status?.type === 'running';
  const cancelled = part.status?.type === 'incomplete' && part.status.reason === 'cancelled';
  const failed = part.isError || (part.status?.type === 'incomplete' && !cancelled);
  const waiting = part.status?.type === 'requires-action';
  const label = cancelled ? '已停止' : failed ? name.failed : waiting ? '等待处理' : name.complete;
  const target = part.args?.query ?? part.args?.url;
  let query = typeof target === 'string' ? target : '';
  if (part.toolName === 'read_web' || part.toolName === 'read_webpage') {
    try {
      query = new URL(query).hostname;
    } catch {
      query = '';
    }
  }
  const result =
    part.result ?? (part.status?.type === 'incomplete' ? part.status.error : undefined);
  return (
    <ToolCall
      label={label}
      activeLabel={name.active}
      query={query}
      request={part.argsText ?? ''}
      result={typeof result === 'string' ? result : (JSON.stringify(result, null, 2) ?? '')}
      running={running}
      icon={
        part.toolName === 'search_web' ? (
          <Search />
        ) : part.toolName.startsWith('read_web') ? (
          <Globe />
        ) : (
          <Wrench />
        )
      }
      open={open}
      onOpenChange={setOpen}
      ariaLabel={`${running ? name.active : label}${query ? ` · ${query}` : ''}`}
      statusIcon={
        cancelled ? (
          <CircleMinus className="size-3.5 text-muted-foreground" />
        ) : failed ? (
          <XCircle className="size-3.5 text-destructive" />
        ) : waiting ? (
          <AlertCircle className="size-3.5 text-muted-foreground" />
        ) : undefined
      }
    />
  );
}
function GenerationProgress() {
  return (
    <div role="status">
      <TraceLine live label="正在生成交互界面…" />
    </div>
  );
}
function AssistantText(part: TextMessagePartProps) {
  const internal = useAuiState((s) =>
    s.message.content.some(
      (p) =>
        p.type === 'tool-call' &&
        (p.toolName === 'prepare_program' || p.toolName === 'present_openui'),
    ),
  );
  if (internal) return null;
  if (part.text === '' && part.status.type === 'running')
    return <TraceLine live label="正在思考…" icon={<Brain />} />;
  if (part.text.startsWith('Program/UI repair limit reached'))
    return <p role="alert">交互界面暂时无法生成。你可以重新发送需求再试一次。</p>;
  if (part.text.startsWith('Model round limit reached'))
    return <p role="alert">本次任务未能完成。你可以重新发送需求继续。</p>;
  return <MarkdownText />;
}
const groupAssistantParts = groupPartByType({
  reasoning: ['group-reasoning'],
  'tool-call': ['group-tool'],
  'tool-call:prepare_program': [],
  'tool-call:present_openui': [],
  'standalone-tool-call': [],
});
function Assistant() {
  const traceTail = useAuiState((s) => {
    const internal = s.message.content.some(
      (part) =>
        part.type === 'tool-call' &&
        (part.toolName === 'prepare_program' || part.toolName === 'present_openui'),
    );
    // Match AssistantText/Tool visibility so hidden publication parts leave no spacing.
    const last = s.message.content.findLast((part) => {
      if (part.type === 'text') return !internal && part.text !== '';
      return (
        part.type !== 'tool-call' ||
        (part.toolName !== 'prepare_program' &&
          (part.toolName !== 'present_openui' || !part.isError))
      );
    });
    return (
      last?.type === 'reasoning' ||
      (last?.type === 'tool-call' && last.toolName !== 'present_openui')
    );
  });
  const generating = useAuiState(
    (s) =>
      s.message.isLast &&
      s.thread.isRunning &&
      s.message.content.some(
        (part) =>
          part.type === 'tool-call' &&
          (part.toolName === 'prepare_program' || part.toolName === 'present_openui') &&
          (part.result === undefined || part.isError),
      ),
  );
  return (
    <MessagePrimitive.Root
      data-slot="assistant-message"
      data-trace-tail={traceTail || generating}
      className="group/message mb-6 flex min-w-0 flex-col gap-2 text-sm leading-relaxed wrap-anywhere empty:hidden data-[trace-tail=true]:mb-2"
    >
      {generating && <GenerationProgress />}
      <MessagePrimitive.GroupedParts groupBy={groupAssistantParts}>
        {({ part, children }) => {
          switch (part.type) {
            case 'group-tool':
              if (part.indices.length === 1) return <>{children}</>;
              return (
                <ToolGroupRoot variant="ghost" defaultOpen>
                  <DisclosureTrigger
                    icon={<Wrench />}
                    live={part.status.type === 'running'}
                    label={part.status.type === 'running' ? '正在调用' : '已调用'}
                    detail={`${part.indices.length} 个工具`}
                    data-slot="tool-group-trigger"
                  />
                  <ToolGroupContent className={`${disclosureContentClass} [&>div]:gap-2!`}>
                    {children}
                  </ToolGroupContent>
                </ToolGroupRoot>
              );
            case 'group-reasoning':
              return (
                <ReasoningRoot
                  variant="ghost"
                  streaming={part.status.type === 'running'}
                  className="mb-0"
                >
                  <DisclosureTrigger
                    icon={<Brain />}
                    live={part.status.type === 'running'}
                    label={part.status.type === 'running' ? '正在思考…' : '思考过程'}
                  />
                  <ReasoningContent
                    aria-busy={part.status.type === 'running'}
                    className={disclosureContentClass}
                  >
                    <ReasoningText className="ps-0">{children}</ReasoningText>
                  </ReasoningContent>
                </ReasoningRoot>
              );
            case 'reasoning':
              return <Reasoning {...part} />;
            case 'text':
              return <AssistantText {...part} />;
            case 'tool-call':
              return <Tool {...part} />;
            case 'indicator':
              return generating ? null : <TraceLine live label="正在思考…" icon={<Brain />} />;
            default:
              return null;
          }
        }}
      </MessagePrimitive.GroupedParts>
    </MessagePrimitive.Root>
  );
}
function User() {
  return (
    <MessagePrimitive.Root className="mb-8 ml-auto w-fit max-w-[85%] rounded-2xl bg-muted px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap wrap-anywhere">
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  );
}
