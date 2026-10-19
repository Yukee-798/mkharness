import { useState } from 'react';
import type { ToolCallMessagePartProps } from '@assistant-ui/react';
import { Download, ImageIcon, LoaderCircle } from 'lucide-react';
import { Button } from '../../browser/ui/button';
import { ImageViewer } from '../../browser/ui/image-viewer';
import { Alert, AlertDescription } from '../../browser/ui/alert';
import { useLocale } from '../../browser/app/locale';
import { useExtensionContext } from '../../browser/extensions/extension-context';
import type { BrowserExtension } from '../../browser/extensions/extensions';
import { TraceLine } from '../../browser/chat/messages/trace';
import { imageFileURL, imageResult } from './contracts';

function DownloadImage({
  url,
  file,
  overlay = false,
  compact = false,
}: {
  url: string;
  file: string;
  overlay?: boolean;
  compact?: boolean;
}) {
  const { t } = useLocale();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  return (
    <span
      className={
        overlay
          ? 'absolute right-3 top-3 z-10 inline-flex max-w-[calc(100%-1.5rem)] flex-col items-end gap-1'
          : 'relative inline-flex flex-col items-end gap-1'
      }
    >
      <Button
        variant={overlay || compact ? 'ghost' : 'outline'}
        size={overlay || compact ? 'icon-sm' : 'sm'}
        className={
          overlay
            ? 'rounded-lg bg-white/25 text-black/60 shadow-none backdrop-blur-sm transition-colors hover:bg-white/85 hover:text-black/90 focus-visible:bg-white/85 focus-visible:text-black/90 dark:hover:bg-white/85 dark:hover:text-black/90'
            : compact
              ? 'rounded-full text-white/85 hover:bg-white/15 hover:text-white'
              : undefined
        }
        aria-label={pending ? t('正在下载…') : t('下载原图')}
        title={pending ? t('正在下载…') : t('下载原图')}
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setError(false);
          try {
            const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
            if (
              !response.ok ||
              !/^image\/(png|jpeg|webp)(;|$)/.test(response.headers.get('Content-Type') ?? '')
            )
              throw new Error('Download failed');
            const objectURL = URL.createObjectURL(await response.blob());
            const link = document.createElement('a');
            link.href = objectURL;
            link.download = file;
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(objectURL), 1000);
          } catch {
            setError(true);
          } finally {
            setPending(false);
          }
        }}
      >
        {pending ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : (
          <Download className="size-4" />
        )}
        <span className={overlay || compact ? 'sr-only' : undefined}>
          {pending ? t('正在下载…') : t('下载原图')}
        </span>
      </Button>
      {error && (
        <span
          role="alert"
          className={`text-xs text-destructive ${compact ? 'absolute right-0 bottom-full mb-3 w-max max-w-[min(18rem,calc(100vw-2rem))] rounded-md border bg-background px-2 py-1 shadow-sm' : overlay ? 'rounded-md border bg-background/95 px-2 py-1 shadow-sm' : ''}`}
        >
          {t('图片下载失败，请重试。')}
        </span>
      )}
    </span>
  );
}
function GeneratedImages(part: ToolCallMessagePartProps) {
  const { t } = useLocale();
  const { id, busy } = useExtensionContext();
  const [preview, setPreview] = useState<{
    url: string;
    downloadURL: string;
    file: string;
    title: string;
  } | null>(null);
  let value: unknown = part.result;
  try {
    if (typeof value === 'string') value = JSON.parse(value);
  } catch {
    value = undefined;
  }
  const parsed = imageResult.safeParse(value);
  if (!parsed.success) {
    // Argument streaming can finish before the server-owned tool. Restored model
    // messages can also be complete while the accepted run is still pending.
    const waiting =
      part.result === undefined &&
      !part.isError &&
      part.status.type !== 'incomplete' &&
      (part.status.type === 'running' || part.status.type === 'requires-action' || busy);
    if (waiting)
      return (
        <div
          role="status"
          aria-live="polite"
          aria-busy="true"
          data-slot="image-generation-status"
          className="my-3 max-w-lg space-y-2 rounded-xl border bg-muted/20 p-4"
        >
          <TraceLine live icon={<ImageIcon />} label={t('正在生成图片…')} />
          <p className="text-xs text-muted-foreground">
            {t('图片生成需要一些时间，完成后会显示在这里。')}
          </p>
        </div>
      );
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {part.status.type === 'incomplete' && part.status.reason === 'cancelled'
            ? t('已停止等待图片。远端生成可能仍在继续。')
            : t('图片生成未完成。请查看回复说明，确认后再尝试。')}
        </AlertDescription>
      </Alert>
    );
  }
  const result = parsed.data;
  return (
    <div className="my-3 grid min-w-0 gap-4" data-slot="generated-images">
      {result.images.map((image, index) => {
        const title = result.images.length > 1 ? `${result.title} · ${index + 1}` : result.title;
        const url = imageFileURL(id, result.ref, image.file);
        return (
          <figure key={image.file} className="min-w-0 max-w-lg space-y-2">
            <div className="relative">
              <Button
                variant="ghost"
                className="h-auto w-full overflow-hidden rounded-xl border bg-muted/20 p-0"
                aria-label={t('查看大图：{title}', { title })}
                onClick={() =>
                  setPreview({
                    url,
                    downloadURL: imageFileURL(id, result.ref, image.file, true),
                    file: image.file,
                    title,
                  })
                }
              >
                <img
                  src={url}
                  alt={title}
                  loading="lazy"
                  className="max-h-80 w-full object-contain"
                />
              </Button>
              <DownloadImage
                overlay
                url={imageFileURL(id, result.ref, image.file, true)}
                file={image.file}
              />
            </div>
            <figcaption className="text-xs text-muted-foreground">{title}</figcaption>
          </figure>
        );
      })}
      {preview && (
        <ImageViewer
          open
          onOpenChange={(open) => {
            if (!open) setPreview(null);
          }}
          src={preview.url}
          title={preview.title}
          download={<DownloadImage compact url={preview.downloadURL} file={preview.file} />}
        />
      )}
    </div>
  );
}
export const toolkit = {
  generate_image: { type: 'backend', display: 'standalone', render: GeneratedImages },
} satisfies BrowserExtension['toolkit'];
