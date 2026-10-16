import { ComposerFooterExtensions } from '../extensions/extension-ui';
import { useLocale } from '../app/locale';
import { ExtensionContext } from '../extensions/extension-context';
import type { ReactNode } from 'react';
import { AssistantRuntimeProvider, ThreadPrimitive } from '@assistant-ui/react';
import { ToolProgressContext } from './messages/tool-progress';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import { Button } from '../ui/button';
import { Alert, AlertDescription } from '../ui/alert';
import { ArrowDown, MessageSquare } from 'lucide-react';
import { Assistant, User } from './messages/AssistantMessage';
import type { ConversationSession } from './session/use-conversation-session';
import { useHistoryScroll } from './session/use-history-scroll';
export function ChatRuntime({
  session,
  footer,
}: {
  session: ConversationSession;
  footer: ReactNode;
}) {
  const { t } = useLocale();
  const { runtime, submit, loadOlder } = session;
  const {
    id,
    userId,
    extensions,
    toolProgress,
    extensionState,
    runtimeIssues,
    messageIds,
    annotations,
    hasOlder,
    historyLoading,
    historyError,
    snapshot,
  } = session.view;
  const busy = session.view.submitting || session.view.hasPending || session.view.isStopping;
  const { viewport, retry: retryHistory } = useHistoryScroll({
    hasOlder,
    loading: historyLoading,
    error: historyError,
    loadOlder,
    firstEntry: snapshot?.entries[0]?.id,
  });
  return (
    <AssistantRuntimeProvider runtime={runtime} config={extensions.config}>
      <ToolProgressContext value={toolProgress}>
        <ExtensionContext
          value={{
            id,
            userId,
            submit,
            busy,
            activity: extensions.activity,
            toolkit: extensions.toolkit,
            ui: extensions.ui,
            state: extensionState,
            annotations,
            messageIds,
          }}
        >
          <ThreadPrimitive.Root aria-label={t('聊天历史')} className="flex min-h-0 flex-1 flex-col">
            <ThreadPrimitive.Viewport
              ref={viewport}
              data-slot="chat-viewport"
              scrollToBottomOnRunStart={false}
              className="group/viewport relative flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain [overflow-anchor:none] has-[[data-slot=chat-welcome]]:justify-center-safe has-[[data-slot=chat-welcome]]:py-8"
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
              {hasOlder && (
                <div
                  className="mx-auto flex min-h-10 items-center justify-center px-4 text-xs text-muted-foreground"
                  role="status"
                >
                  {historyError ? (
                    <Button variant="ghost" size="sm" onClick={retryHistory}>
                      {t('历史消息加载失败，点击重试')}
                    </Button>
                  ) : historyLoading ? (
                    t('正在加载历史消息…')
                  ) : (
                    t('向上滚动加载更早的消息')
                  )}
                </div>
              )}
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
                {runtimeIssues.length > 0 && (
                  <Alert>
                    <AlertDescription>
                      {runtimeIssues.some((issue) => issue.code === 'compaction_failed')
                        ? t('上下文压缩失败，部分任务可能无法继续。请检查模型配置后再发送请求。')
                        : t('部分任务无法恢复，请联系应用维护者。')}
                    </AlertDescription>
                  </Alert>
                )}
                <ComposerFooterExtensions />
                {footer}
              </ThreadPrimitive.ViewportFooter>
            </ThreadPrimitive.Viewport>
          </ThreadPrimitive.Root>
        </ExtensionContext>
      </ToolProgressContext>
    </AssistantRuntimeProvider>
  );
}
