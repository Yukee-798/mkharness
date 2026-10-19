import { useRef, useState, type ReactNode } from 'react';
import { Expand, LoaderCircle, Minus, Plus, X } from 'lucide-react';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from './dialog';
import { Button } from './button';
import { useLocale } from '../app/locale';

const controlStyle = 'rounded-full text-white/85 hover:bg-white/15 hover:text-white';
const clampZoom = (value: number) => Math.min(4, Math.max(0.25, value));

/** A transient view of an existing image; it never changes the workspace or generates content. */
export function ImageViewer({
  open,
  onOpenChange,
  src,
  title,
  download,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  src: string;
  title: string;
  download?: ReactNode;
}) {
  const returnFocus = useRef<HTMLElement | null>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        onOpenAutoFocus={() => {
          returnFocus.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus.current?.focus();
        }}
        overlayClassName="bg-black/75 backdrop-blur-sm"
        className="top-0 left-0 h-dvh w-dvw max-w-none translate-x-0 translate-y-0 gap-0 overflow-hidden rounded-none border-0 bg-transparent p-0 shadow-none sm:max-w-none"
        data-slot="image-preview"
      >
        <ImageViewerBody key={src} src={src} title={title} download={download} />
      </DialogContent>
    </Dialog>
  );
}

function ImageViewerBody({
  src,
  title,
  download,
}: {
  src: string;
  title: string;
  download?: ReactNode;
}) {
  const { t } = useLocale();
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const image = useRef<HTMLImageElement>(null);
  const drag = useRef<{ x: number; y: number; pan: typeof pan } | null>(null);
  const changeZoom = (value: number) => {
    setZoom(clampZoom(value));
    setPan({ x: 0, y: 0 });
  };
  return (
    <div
      className="relative h-full min-h-0 w-full"
      onKeyDown={(event) => {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (['+', '=', '-', '0'].includes(event.key)) {
          event.preventDefault();
          changeZoom(event.key === '0' ? 1 : zoom + (event.key === '-' ? -0.25 : 0.25));
        }
      }}
    >
      <DialogTitle className="absolute top-5 right-16 left-4 z-10 truncate text-sm font-medium text-white/80">
        {title}
      </DialogTitle>
      <DialogDescription className="sr-only">{t('图片预览，可缩放并拖动查看。')}</DialogDescription>
      <DialogClose asChild>
        <Button
          variant="ghost"
          size="icon"
          className={`absolute top-3 right-3 z-20 ${controlStyle}`}
          aria-label={t('关闭图片预览')}
        >
          <X />
        </Button>
      </DialogClose>
      <div
        className={`absolute inset-0 flex items-center justify-center overflow-hidden px-4 pt-16 pb-20 ${zoom > 1 ? 'touch-none cursor-grab active:cursor-grabbing' : ''}`}
        onPointerDown={(event) => {
          if (
            zoom <= 1 ||
            loading ||
            failed ||
            event.button !== 0 ||
            (event.target instanceof Element && event.target.closest('button'))
          )
            return;
          drag.current = { x: event.clientX, y: event.clientY, pan };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!drag.current || !image.current) return;
          const boundsX = Math.max(
            0,
            (image.current.offsetWidth * zoom - event.currentTarget.clientWidth + 32) / 2,
          );
          const boundsY = Math.max(
            0,
            (image.current.offsetHeight * zoom - event.currentTarget.clientHeight + 144) / 2,
          );
          setPan({
            x: Math.max(
              -boundsX,
              Math.min(boundsX, drag.current.pan.x + event.clientX - drag.current.x),
            ),
            y: Math.max(
              -boundsY,
              Math.min(boundsY, drag.current.pan.y + event.clientY - drag.current.y),
            ),
          });
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
      >
        {failed ? (
          <div role="alert" className="space-y-3 text-center text-sm text-white">
            <p>{t('图片无法读取，请重新打开。')}</p>
            <Button
              variant="secondary"
              onClick={() => {
                setFailed(false);
                setLoading(true);
                setAttempt((value) => value + 1);
              }}
            >
              {t('重试')}
            </Button>
          </div>
        ) : (
          <>
            {loading && (
              <span role="status" className="absolute text-white/80">
                <LoaderCircle className="size-6 animate-spin" />
                <span className="sr-only">{t('正在读取图片…')}</span>
              </span>
            )}
            <img
              key={attempt}
              ref={image}
              src={src}
              alt={title}
              draggable={false}
              onLoad={() => setLoading(false)}
              onError={() => {
                setLoading(false);
                setFailed(true);
              }}
              className={`max-h-full max-w-full shrink-0 object-contain select-none ${loading ? 'opacity-0' : ''}`}
              style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
            />
          </>
        )}
      </div>
      <div className="absolute bottom-4 left-1/2 z-20 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-1 rounded-full border border-white/10 bg-black/50 p-1 backdrop-blur-md">
        <Button
          variant="ghost"
          size="icon-sm"
          className={controlStyle}
          aria-label={t('缩小图片')}
          disabled={zoom <= 0.25 || loading || failed}
          onClick={() => changeZoom(zoom - 0.25)}
        >
          <Minus />
        </Button>
        <output
          className="w-12 text-center text-xs text-white/85 tabular-nums"
          aria-label={t('图片缩放比例')}
        >
          {Math.round(zoom * 100)}%
        </output>
        <Button
          variant="ghost"
          size="icon-sm"
          className={controlStyle}
          aria-label={t('放大图片')}
          disabled={zoom >= 4 || loading || failed}
          onClick={() => changeZoom(zoom + 0.25)}
        >
          <Plus />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className={controlStyle}
          aria-label={t('适应窗口')}
          title={t('适应窗口')}
          onClick={() => changeZoom(1)}
        >
          <Expand />
        </Button>
        {download}
      </div>
    </div>
  );
}
