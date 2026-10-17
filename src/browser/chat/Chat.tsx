import { useConversationSession } from './session/use-conversation-session';
import type { QueueDraft } from '../../shared/queue';
import { ImageComposer, AddImage } from './image-attachments';
import { useLocale } from '../app/locale';
import { useState, useRef, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import type { Json } from '../../shared/json';
import type { RunCommand } from '../../shared/contracts';
import { TaskQueue } from './task-queue';
import { ResourceDrafts } from '../extensions/ResourceDrafts';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { ChatLoading } from './chat-loading';
import { Alert, AlertDescription } from '../ui/alert';
import { ModelPicker } from '../models/model-picker';
import { resolveModelSelection } from '../../shared/model-selection';
import { ArrowUp, Check, Square, LoaderCircle } from 'lucide-react';
import { ChatRuntime } from './ChatRuntime';
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
  const renderedSnapshot = snapshot;
  const [text, setText] = useState('');
  const [draftSource, setDraftSource] = useState<RunCommand['source']>();
  const [editingQueue, setEditingQueue] = useState(false);
  const draftVersion = useRef(0);
  const composerVersion = draftVersion.current;
  const { submit, reportError: setError, selectModel: setSelection } = session;
  const footer = (
    <div className="space-y-3">
      <TaskQueue
        items={snapshot?.queue ?? []}
        recoveries={snapshot?.queueEdits ?? []}
        disabled={submitting || isStopping}
        hasDraft={!!text}
        editing={setEditingQueue}
        act={session.actOnQueue}
        acknowledge={session.acknowledgeQueueEdit}
        edit={(draft: QueueDraft) => {
          flushSync(() => {
            draftVersion.current++;
            setText(draft.text);
            setDraftSource(draft.source);
            if (draft.config && catalog) setSelection(resolveModelSelection(catalog, draft.config));
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
          const submittedVersion = composerVersion;
          try {
            await submit(text, draftSource, images);
            if (draftVersion.current === submittedVersion) {
              setText('');
              setDraftSource(undefined);
            }
            return true;
          } catch (e) {
            setError(e as Error);
            return false;
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
                if (!e.target.value) setDraftSource(undefined);
              }}
              rows={2}
              placeholder={t('描述你的问题，或说说你想完成什么')}
              className="max-h-40 min-h-14 resize-none rounded-none border-0 px-1 py-1 text-base shadow-none focus-visible:ring-0 md:text-sm"
              disabled={!composerReady || isStopping || editingQueue}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <AddImage disabled={!composerReady || submitting || isStopping || editingQueue} />
              <div className="min-w-0 flex-1">
                {catalog && selected ? (
                  <ModelPicker
                    catalog={catalog}
                    value={selected}
                    onChange={setSelection}
                    disabled={submitting || isStopping || editingQueue}
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
                onClick={hasPending ? session.stop : undefined}
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
          <ChatRuntime key={`${userId}:${id}`} session={session} footer={footer} />
        ) : (
          <>
            <ChatLoading />
            <div className="mx-auto w-full max-w-3xl px-4 pb-4">
              {visibleError && (
                <Alert variant="destructive">
                  <AlertDescription>
                    {t(visibleError.message)}
                    <Button variant="outline" size="sm" onClick={session.reconnect}>
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

export function Chat(props: Parameters<typeof ConversationChat>[0]) {
  return <ConversationChat key={`${props.userId}:${props.id}`} {...props} />;
}
