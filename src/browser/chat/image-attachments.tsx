import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  SimpleImageAttachmentAdapter,
  useAui,
  useAuiEvent,
  useAuiState,
  type PendingAttachment,
} from '@assistant-ui/react';
import { ImagePlus, X } from 'lucide-react';
import { Button } from '../ui/button';
import { Alert, AlertDescription } from '../ui/alert';
import { useLocale } from '../app/locale';
import type { ComposerDraft } from '../workbench/composer-drafts';
import {
  IMAGE_LIMITS,
  imageTypes,
  imagesSchema,
  matchesImageType,
  type ImageAttachment,
} from '../../shared/images';

class ImageAdapter extends SimpleImageAttachmentAdapter {
  override accept = imageTypes.join(',');
  override async add({ file }: { file: File }) {
    if (!imageTypes.some((type) => type === file.type))
      throw new Error('仅支持 PNG、JPEG、WebP 或 GIF 图片');
    if (file.size > IMAGE_LIMITS.bytes) throw new Error('图片总大小不能超过 512 KiB');
    if (!matchesImageType(new Uint8Array(await file.slice(0, 12).arrayBuffer()), file.type))
      throw new Error('仅支持有效的 PNG、JPEG、WebP 或 GIF 图片');
    if (file.name.length > 200) throw new Error('图片文件名过长');
    return super.add({ file });
  }
}
export const imageAttachmentAdapter = new ImageAdapter();

function ImagePreview({ removable = false }: { removable?: boolean }) {
  const attachment = useAuiState((state) => state.attachment);
  const { t } = useLocale();
  const [local, setLocal] = useState<string>();
  const file = 'file' in attachment ? attachment.file : undefined;
  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setLocal(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const image = attachment.content?.find((part) => part.type === 'image');
  const src = image?.type === 'image' ? image.image : local;
  return (
    <AttachmentPrimitive.Root className="relative flex w-24 shrink-0 flex-col gap-1 rounded-lg border bg-background p-1.5">
      {src && (
        <img src={src} alt={attachment.name} className="h-20 w-full rounded object-contain" />
      )}
      <span className="truncate text-[10px] text-muted-foreground">
        <AttachmentPrimitive.Name />
      </span>
      {removable && (
        <AttachmentPrimitive.Remove asChild>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="absolute -top-2 -right-2 size-5 rounded-full"
            aria-label={t('移除图片')}
          >
            <X className="size-3" />
          </Button>
        </AttachmentPrimitive.Remove>
      )}
    </AttachmentPrimitive.Root>
  );
}
export function MessageImages() {
  return (
    <div className="mb-2 flex flex-wrap gap-2 empty:hidden">
      <MessagePrimitive.Attachments>{() => <ImagePreview />}</MessagePrimitive.Attachments>
    </div>
  );
}
export function AddImage({ disabled }: { disabled: boolean }) {
  const { t } = useLocale();
  return (
    <ComposerPrimitive.AddAttachment asChild>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="shrink-0"
        disabled={disabled}
        aria-label={t('添加图片')}
      >
        <ImagePlus className="size-4" />
      </Button>
    </ComposerPrimitive.AddAttachment>
  );
}
/** Native attachment state, one HTTP submission. Never invoke the AG-UI send path. */
export function ImageComposer({
  onSubmit,
  children,
  draft,
  ...props
}: {
  onSubmit: (images?: ImageAttachment[]) => Promise<boolean>;
  children: (hasImages: boolean) => ReactNode;
  className?: string;
  draft?: ComposerDraft;
}) {
  const aui = useAui();
  const attachments = useAuiState((state) => state.composer.attachments);
  const [error, setError] = useState<string>();
  const preparing = useRef(false);
  const mounted = useRef(true);
  const restoring = useRef(false);
  const retired = useRef(new Set<string>());
  const initialized = useRef(false);
  useEffect(() => {
    if (!draft) return;
    const sync = () => {
      const text = draft.getSnapshot().text;
      if (aui.composer().getState().text !== text) aui.composer().setText(text);
    };
    sync();
    return draft.subscribe(sync);
  }, [aui, draft]);
  const remember = useCallback(() => {
    if (!draft || restoring.current) return;
    draft.setImages(
      aui
        .composer()
        .getState()
        .attachments.filter((attachment) => !retired.current.has(attachment.id))
        .map((attachment) => ({
          id: attachment.id,
          input:
            'file' in attachment && attachment.file
              ? attachment.file
              : {
                  type: attachment.type,
                  name: attachment.name,
                  contentType: attachment.contentType,
                  content: attachment.content ?? [],
                },
        })),
    );
  }, [aui, draft]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!draft) return;
    let previous = draft.getSnapshot().images;
    return draft.subscribe(() => {
      const next = draft.getSnapshot().images;
      const present = new Set(next.map((image) => image.id));
      for (const image of previous) if (!present.has(image.id)) retired.current.add(image.id);
      previous = next;
      // A receipt can arrive after leaving and reopening this chat. Remove the
      // original images from this runtime too, without touching newer uploads.
      for (const attachment of aui.composer().getState().attachments)
        if (retired.current.has(attachment.id))
          void aui.composer().attachment({ id: attachment.id }).remove();
    });
  }, [aui, draft]);
  useEffect(() => {
    if (!draft || initialized.current) return;
    initialized.current = true;
    const images = [...draft.getSnapshot().images];
    if (!images.length) return;
    restoring.current = true;
    void (async () => {
      try {
        for (const image of images) {
          if (!mounted.current) return;
          const input =
            image.input instanceof File
              ? await imageAttachmentAdapter.send(
                  await imageAttachmentAdapter.add({ file: image.input }),
                )
              : image.input;
          if (!mounted.current || retired.current.has(image.id)) continue;
          await aui.composer().addAttachment({ ...input, id: image.id });
        }
      } catch (error) {
        if (mounted.current) setError(error instanceof Error ? error.message : String(error));
      } finally {
        restoring.current = false;
        if (mounted.current) remember();
      }
    })();
  }, [aui, draft, remember]);
  useEffect(() => {
    if (attachments) remember();
  }, [attachments, remember]);
  const { t } = useLocale();
  useAuiEvent('composer.attachmentAddError', ({ message, reason }) =>
    setError(reason === 'not-accepted' ? '仅支持 PNG、JPEG、WebP 或 GIF 图片' : message),
  );
  return (
    <ComposerPrimitive.Root
      {...props}
      onSubmit={async (event) => {
        event.preventDefault();
        if (preparing.current) return;
        preparing.current = true;
        setError(undefined);
        // Capture this draft; late acknowledgements must not clear subsequently added images.
        const captured = [...aui.composer().getState().attachments];
        try {
          const complete = await Promise.all(
            captured.map((attachment) =>
              attachment.status.type === 'complete'
                ? attachment
                : imageAttachmentAdapter.send(attachment as PendingAttachment),
            ),
          );
          const images = complete.map((attachment) => {
            const image = attachment.content?.find((part) => part.type === 'image');
            if (image?.type !== 'image')
              throw new Error('仅支持有效的 PNG、JPEG、WebP 或 GIF 图片');
            const match = /^data:([^;]+);base64,(.+)$/.exec(image.image);
            if (!match) throw new Error('仅支持有效的 PNG、JPEG、WebP 或 GIF 图片');
            return { name: attachment.name, mimeType: match[1], data: match[2] };
          });
          const validated = images.length ? imagesSchema.safeParse(images) : undefined;
          if (validated && !validated.success)
            throw new Error('最多添加 4 张图片，总大小不能超过 512 KiB');
          if (await onSubmit(validated?.data)) {
            draft?.removeImages(new Set(captured.map((attachment) => attachment.id)));
            if (!mounted.current) return;
            for (const attachment of captured)
              if (
                aui
                  .composer()
                  .getState()
                  .attachments.some((current) => current.id === attachment.id)
              )
                await aui.composer().attachment({ id: attachment.id }).remove();
          }
        } catch (error) {
          setError(error instanceof Error ? error.message : String(error));
        } finally {
          preparing.current = false;
        }
      }}
    >
      <div className="mb-2 flex flex-wrap gap-2 empty:hidden">
        <ComposerPrimitive.Attachments>
          {() => <ImagePreview removable />}
        </ComposerPrimitive.Attachments>
      </div>
      {error && (
        <Alert variant="destructive" className="mb-2">
          <AlertDescription>{t(error)}</AlertDescription>
        </Alert>
      )}
      {children(attachments.length > 0)}
    </ComposerPrimitive.Root>
  );
}
