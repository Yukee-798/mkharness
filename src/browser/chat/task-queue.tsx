import { useEffect, useRef, useState } from 'react';
import {
  AuiConfig,
  AuiProvider,
  ExternalThread,
  ComposerPrimitive,
  QueueItemPrimitive,
  useAui,
  useAuiState,
  type ExternalThreadQueueAdapter,
} from '@assistant-ui/react';
import {
  CornerDownRight,
  Pencil,
  Trash2,
  ChevronDown,
  ChevronUp,
  ListOrdered,
  ImageIcon,
} from 'lucide-react';
import { Button } from '../ui/button';
import { Alert, AlertDescription } from '../ui/alert';
import { useLocale } from '../app/locale';
import type { QueueAction, QueueActionResult, QueueDraft, QueuedInput } from '../../shared/queue';

const messages: [] = [];
const unsupported = () => {
  throw new Error('Queue submission and editing belong to the host HTTP path');
};
/** Read-only native inbox projection. The local provider only supplies queue primitives;
 * it has no send, cancel, scheduling, observation or model path. */
export function TaskQueue({
  items,
  disabled,
  hasDraft,
  act,
  edit,
  editing,
}: {
  items: readonly QueuedInput[];
  disabled: boolean;
  hasDraft: boolean;
  act: (id: string, action: QueueAction) => Promise<QueueActionResult>;
  edit: (draft: QueueDraft) => void;
  editing: (value: boolean) => void;
}) {
  const parent = useAui();
  const imageCount = useAuiState((s) => s.composer.attachments.length);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { t } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  const [failed, setFailed] = useState<{ id: string; action: QueueAction; message: string }>();
  const perform = async (id: string, action: QueueAction) => {
    if (guard.current || disabled) return;
    if (action === 'edit' && (hasDraft || parent.composer().getState().attachments.length)) return;
    guard.current = true;
    setBusy(true);
    setFailed(undefined);
    if (action === 'edit') editing(true);
    try {
      const result = await act(id, action);
      if (!mounted.current) return;
      if (result.draft) {
        // Restore to the real composer, never the display-only queue provider.
        edit(result.draft);
        for (const image of result.draft.images ?? []) {
          const bytes = Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0));
          await parent
            .composer()
            .addAttachment(new File([bytes], image.name, { type: image.mimeType }));
        }
      }
    } catch (error) {
      if (mounted.current)
        setFailed({ id, action, message: error instanceof Error ? error.message : String(error) });
    } finally {
      guard.current = false;
      setBusy(false);
      if (action === 'edit') editing(false);
    }
  };
  const adapter: ExternalThreadQueueAdapter = {
    items: items.map((item) => ({
      id: item.runId,
      prompt: item.text,
      parts: [
        {
          type: 'text',
          text: item.text || item.images?.map((image) => image.name).join(', ') || '',
        },
      ],
    })),
    steerItems: [],
    // This subtree only renders queued items; sends use the existing HTTP composer.
    enqueue: unsupported,
    steer: unsupported,
    edit: unsupported,
    move: (id, placement) => {
      if (
        placement.lane !== 'steer' ||
        placement.insertBefore !== undefined ||
        (placement.insertAfter !== undefined && placement.insertAfter !== null)
      )
        unsupported();
      void perform(id, 'steer');
    },
    remove: (id) => {
      void perform(id, 'remove');
    },
  };
  const config = AuiConfig({ thread: ExternalThread({ messages, queue: adapter }) });
  if (!items.length && !failed) return null;
  return (
    <section
      data-slot="task-queue"
      aria-label={t('待执行任务')}
      className="overflow-hidden rounded-xl border bg-muted/20 text-sm"
    >
      {!!items.length && (
        <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
          <ListOrdered className="size-3.5" />
          <span className="flex-1">{t('待执行 · {count}', { count: items.length })}</span>
          {items.length > 2 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => setExpanded(!expanded)}
              aria-expanded={expanded}
            >
              {expanded ? t('收起') : t('展开全部')}
              {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
            </Button>
          )}
        </div>
      )}
      <AuiProvider extends={parent} config={config}>
        <ComposerPrimitive.Queue>
          {({ queueItem }) => {
            const index = items.findIndex((item) => item.runId === queueItem.id);
            const item = items[index];
            if (!item || (!expanded && index >= 2)) return null;
            return (
              <div
                data-slot="queue-item"
                className="flex min-w-0 items-center gap-2 border-t px-3 py-2"
                data-run-id={item.runId}
              >
                {item.images
                  ?.slice(0, 1)
                  .map((image, i) =>
                    image.data ? (
                      <img
                        key={i}
                        src={`data:${image.mimeType};base64,${image.data}`}
                        alt={image.name}
                        className="size-8 shrink-0 rounded border object-cover"
                      />
                    ) : (
                      <ImageIcon
                        key={i}
                        className="size-5 shrink-0 text-muted-foreground"
                        role="img"
                        aria-label={image.name}
                      />
                    ),
                  )}
                {(item.images?.length ?? 0) > 1 && (
                  <span className="text-xs text-muted-foreground">+{item.images!.length - 1}</span>
                )}
                <div className="min-w-0 flex-1">
                  <QueueItemPrimitive.Text
                    title={item.text || item.images?.map((image) => image.name).join(', ')}
                    className="block truncate"
                  />
                  {item.mode === 'steer' && (
                    <span className="block text-xs text-muted-foreground">{t('等待引导')}</span>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    aria-label={t('重新编辑')}
                    title={hasDraft ? t('先发送或清空当前草稿') : t('重新编辑')}
                    disabled={disabled || busy || hasDraft || !!imageCount}
                    onClick={() => void perform(item.runId, 'edit')}
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                  <QueueItemPrimitive.Steer asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1 px-2 text-xs"
                      disabled={disabled || busy || item.mode === 'steer'}
                    >
                      <CornerDownRight className="size-3.5" />
                      {t('引导')}
                    </Button>
                  </QueueItemPrimitive.Steer>
                  <QueueItemPrimitive.Remove asChild>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      aria-label={t('移除排队消息')}
                      disabled={disabled || busy}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </QueueItemPrimitive.Remove>
                </div>
              </div>
            );
          }}
        </ComposerPrimitive.Queue>
      </AuiProvider>
      {failed && (
        <Alert variant="destructive" className="rounded-none border-0 border-t">
          <AlertDescription>
            {t(failed.message)}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || disabled}
              onClick={() => void perform(failed.id, failed.action)}
            >
              {t('重试')}
            </Button>
          </AlertDescription>
        </Alert>
      )}
    </section>
  );
}
