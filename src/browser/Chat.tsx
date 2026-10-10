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
import { Badge } from './ui/badge';
import { Alert, AlertDescription } from './ui/alert';
import { MarkdownText } from './markdown-text';
import { TooltipIconButton } from './tooltip-icon-button';
import {
  ToolFallbackRoot,
  ToolFallbackTrigger,
  ToolFallbackContent,
  ToolFallbackResult,
  ToolFallbackError,
} from './tool-fallback';
import { ArrowUp, ArrowDown, MessageSquare, Square, LoaderCircle } from 'lucide-react';
export type Snapshot = {
  entries: EntryRecord[];
  cursor?: unknown;
  pending: { operationId: string; status: 'running' | 'queued' }[];
  stopping: boolean;
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
  const [retries, setRetries] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void loadSnapshot(id, controller.signal)
      .then((s) => {
        setSnapshot(s);
        setAccepted([]);
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
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
    await send(message, source);
    onDirectoryChange?.();
    setAccepted((a) => [...a, message]);
    setRetries(0);
    setError('');
    if (!snapshot?.pending.length) setRevision((r) => r + 1);
  };
  const refresh = () => {
    setRetries(0);
    setRevision((r) => r + 1);
    onDirectoryChange?.();
  };
  const reconnect = (replacement = false) => {
    if (!replacement && retries >= 4) {
      setError('恢复观察失败。任务仍在后端运行，可以重新连接。');
      return;
    }
    if (!replacement) setRetries((n) => n + 1);
    setTimeout(
      () => setRevision((r) => r + 1),
      replacement ? 0 : Math.min(500 * 2 ** retries, 4000),
    );
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
      {!!snapshot?.pending.length && (
        <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="secondary">
            <LoaderCircle className="size-3 motion-safe:animate-spin" />
            {snapshot.stopping ? '正在停止…' : '任务运行中'}
          </Badge>
          <span>{snapshot.pending.filter((p) => p.status === 'queued').length} 项排队</span>
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
                setRetries(0);
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
          placeholder="描述你的问题，或请求一个可交互的分析面板"
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
          <span className="px-1 text-[11px] text-muted-foreground">Shift + Enter 换行</span>
          <div className="flex items-center gap-2">
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
            footer={footer}
          />
        ) : (
          <>
            <p role="status" className="flex-1 p-8 text-sm text-muted-foreground">
              正在恢复聊天…
            </p>
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
  footer,
}: {
  id: string;
  snapshot: Snapshot;
  submit: (text: string, source?: RunCommand['source']) => Promise<void>;
  done: () => void;
  reconnect: (replacement?: boolean) => void;
  footer: ReactNode;
}) {
  const history = useMemo(() => {
    const messages = fromAgUiMessages(toMessages(snapshot.entries), {
      showThinking: false,
    }).map((m) => fromThreadMessageLike(m, m.id!, { type: 'complete', reason: 'stop' }));
    return {
      messages: messages.map((message, i) => ({
        parentId: i ? messages[i - 1].id : null,
        message,
      })),
      headId: messages.at(-1)?.id ?? null,
    };
  }, [snapshot.entries]);
  const callbacks = useRef({ done, reconnect });
  callbacks.current = { done, reconnect };
  const agent = useMemo(
    () =>
      new AttachAgent(
        id,
        () => callbacks.current.done(),
        () => callbacks.current.reconnect(),
      ),
    [id],
  );
  const runtime = useAgUiRuntime({
    agent,
    showThinking: false,
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
  const names: Record<string, string> = {
    read_webpage: '读取网页',
    search_web: '联网搜索',
  };
  // A completed tool call may still have returned an application error.
  const status: ToolCallMessagePartProps['status'] =
    part.isError && part.status?.type !== 'incomplete'
      ? { type: 'incomplete', reason: 'error', error: part.result }
      : part.status;
  return (
    <ToolFallbackRoot defaultOpen={part.isError} className="my-3">
      <ToolFallbackTrigger toolName={names[part.toolName] ?? part.toolName} status={status} />
      <ToolFallbackContent>
        {!part.isError && <ToolFallbackResult result={part.result} />}
        <ToolFallbackError status={status} />
      </ToolFallbackContent>
    </ToolFallbackRoot>
  );
}
function GenerationProgress() {
  return (
    <p role="status" className="my-3 flex items-center gap-2 text-sm text-muted-foreground">
      <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />
      正在生成交互界面…
    </p>
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
  if (part.text.startsWith('Program/UI repair limit reached'))
    return <p role="alert">交互界面暂时无法生成。你可以重新发送需求再试一次。</p>;
  if (part.text.startsWith('Model round limit reached'))
    return <p role="alert">本次任务未能完成。你可以重新发送需求继续。</p>;
  return <MarkdownText />;
}
function Assistant() {
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
    <MessagePrimitive.Root className="group/message mb-8 min-w-0 text-sm leading-relaxed wrap-anywhere empty:hidden">
      {generating && <GenerationProgress />}
      <MessagePrimitive.Parts components={{ Text: AssistantText, tools: { Fallback: Tool } }} />
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
