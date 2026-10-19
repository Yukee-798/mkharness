import { WorkspaceReferences } from '../workspace/provider';
import { useConversationSession } from './session/use-conversation-session';
import type { QueueDraft } from '../../shared/queue';
import { ImageComposer, AddImage } from './image-attachments';
import { useLocale } from '../app/locale';
import { useState, useRef, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import type { Json } from '../../shared/json';
import { TaskQueue } from './task-queue';
import { ResourceDrafts } from '../extensions/ResourceDrafts';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { Label } from '../ui/label';
import { ComposerPrimitive } from '@assistant-ui/react';
import { Alert, AlertDescription } from '../ui/alert';
import { ModelPicker } from '../models/model-picker';
import { resolveModelSelection } from '../../shared/model-selection';
import { ArrowUp, Check, Square, LoaderCircle } from 'lucide-react';
import { ChatRuntime } from './ChatRuntime';
import { useComposerDraft } from '../workbench/composer-drafts';
function ConversationChat({
  id,
  userId,
  onDirectoryChange,
  onUnavailable,
  onCreated,
  onSettings,
  onModelProviderChange,
  creation,
  newChatControls,
}: {
  id: string;
  userId: string;
  onDirectoryChange?: () => void;
  onUnavailable?: () => void;
  onCreated?: (id: string) => void;
  onSettings?: (provider?: string) => void;
  onModelProviderChange?: (provider: string | undefined) => void;
  creation?: Record<string, Json>;
  newChatControls?: (disabled: boolean) => ReactNode;
}) {
  const { t } = useLocale();
  const session = useConversationSession({
    id,
    userId,
    onDirectoryChange,
    onUnavailable,
    onCreated,
    onSettings,
    onModelProviderChange,
    creation,
  });
  const {
    snapshot,
    catalog,
    selected,
    submitting,
    hasPending,
    isStopping,
    composerReady,
    connection,
    error: visibleError,
    credentialRequired,
  } = session.view;
  const draft = useComposerDraft(id);
  const { text, workspaceReferences } = useSyncExternalStore(
    draft.subscribe,
    draft.getSnapshot,
    draft.getSnapshot,
  );
  const [editingQueue, setEditingQueue] = useState(false);
  const { submit, reportError: setError, selectModel: setSelection } = session;
  const restoredModel = useRef(false);
  useEffect(() => {
    if (!catalog || restoredModel.current) return;
    restoredModel.current = true;
    const config = draft.getSnapshot().config;
    if (config) setSelection(resolveModelSelection(catalog, config));
  }, [catalog, draft, setSelection]);
  const footer = (
    <div className="space-y-3">
      <WorkspaceReferences />
      <TaskQueue
        items={snapshot?.queue ?? []}
        recoveries={snapshot?.queueEdits ?? []}
        disabled={submitting || isStopping}
        hasDraft={!!text || !!workspaceReferences.length}
        editing={setEditingQueue}
        act={session.actOnQueue}
        acknowledge={session.acknowledgeQueueEdit}
        edit={(queuedDraft: QueueDraft) => {
          flushSync(() => {
            draft.restore(queuedDraft);
            if (queuedDraft.config && catalog) {
              draft.setConfig(queuedDraft.config);
              setSelection(resolveModelSelection(catalog, queuedDraft.config));
            }
          });
        }}
      />
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
          {!!snapshot?.queue?.length && (
            <span className="tabular-nums">
              {t('{count} 项排队', {
                count: snapshot.queue!.length,
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
            ) : session.view.submissionFailed ? (
              <Button variant="outline" size="sm" onClick={session.retrySubmission}>
                {t('重试提交')}
              </Button>
            ) : id ? (
              <Button variant="outline" size="sm" onClick={session.reconnect}>
                {t('重新连接')}
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      )}
      {!id && newChatControls?.(submitting)}
      <ImageComposer
        draft={draft}
        className="rounded-2xl border bg-background p-3 shadow-sm transition-shadow focus-within:ring-2 focus-within:ring-ring/20"
        onSubmit={async (images) => {
          if (
            !composerReady ||
            (!text.trim() && !images?.length) ||
            submitting ||
            isStopping ||
            editingQueue
          )
            return false;
          const captured = draft.getSnapshot();
          const submittedVersion = captured.version;
          try {
            await submit(captured.text, captured.source, images, captured.workspaceReferences);
            draft.clearText(submittedVersion);
            return true;
          } catch (e) {
            setError(e as Error);
            return false;
          }
        }}
      >
        {(hasImages) => (
          <>
            <Label htmlFor="message" className="sr-only">
              {t('消息')}
            </Label>
            <ComposerPrimitive.Input
              asChild
              cancelOnEscape={false}
              submitMode="none"
              onKeyDown={(event) => {
                // The host can enqueue while observing a run; keyboard sends use
                // the same HTTP form path, never AG-UI's send/steer actions.
                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing &&
                  event.keyCode !== 229
                ) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            >
              <Textarea
                id="message"
                value={text}
                onChange={(e) => {
                  draft.edit(e.target.value);
                }}
                rows={2}
                placeholder={t('描述你的问题，或说说你想完成什么')}
                className="max-h-40 min-h-14 resize-none rounded-none border-0 px-1 py-1 text-base shadow-none focus-visible:ring-0 md:text-sm"
                disabled={!composerReady || isStopping || editingQueue}
              />
            </ComposerPrimitive.Input>
            <div className="mt-2 flex items-center justify-between gap-2">
              <AddImage disabled={!composerReady || submitting || isStopping || editingQueue} />
              <div className="min-w-0 flex-1">
                {catalog && selected ? (
                  <ModelPicker
                    catalog={catalog}
                    value={selected}
                    onChange={(value) => {
                      draft.setConfig(value);
                      setSelection(value);
                    }}
                    disabled={submitting || isStopping || editingQueue}
                  />
                ) : (
                  <span className="px-1 text-[11px] text-muted-foreground">
                    {t('Shift + Enter 换行')}
                  </span>
                )}
              </div>
              <ComposerAction stopping={hasPending || isStopping} stop={session.stop}>
                <Button
                  type="button"
                  size="icon"
                  aria-busy={submitting || isStopping}
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
                    editingQueue ||
                    (!hasPending &&
                      ((!text.trim() && !hasImages) || (!id && session.view.settingsPending)))
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
              </ComposerAction>
            </div>
          </>
        )}
      </ImageComposer>
    </div>
  );
  return (
    <ResourceDrafts>
      <div className="chat flex min-h-0 flex-1 flex-col">
        <ChatRuntime key={`${userId}:${id}`} session={session} footer={footer} />
      </div>
    </ResourceDrafts>
  );
}

/** Native action UI; prevent its default runtime action so HTTP remains the only submit/cancel path. */
function ComposerAction({
  stopping,
  stop,
  children,
}: {
  stopping: boolean;
  stop: () => void;
  children: ReactNode;
}) {
  const Action = stopping ? ComposerPrimitive.Cancel : ComposerPrimitive.Send;
  return (
    <Action
      asChild
      onClick={(event) => {
        event.preventDefault();
        if (stopping) stop();
        else event.currentTarget.form?.requestSubmit();
      }}
    >
      {children}
    </Action>
  );
}

export function Chat(props: Parameters<typeof ConversationChat>[0]) {
  return <ConversationChat key={`${props.userId}:${props.id}`} {...props} />;
}
