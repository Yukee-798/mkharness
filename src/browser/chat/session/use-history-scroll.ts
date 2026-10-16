import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

/** Viewport Adapter: paging preserves the first visible message, including live replies. */
export function useHistoryScroll({
  hasOlder,
  loading,
  error,
  loadOlder,
  firstEntry,
}: {
  hasOlder: boolean;
  loading: boolean;
  error?: Error;
  loadOlder: () => Promise<void>;
  firstEntry?: number;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const anchor = useRef<
    | {
        id: string;
        first: string;
        entry?: number;
        top: number;
        scrollHeight: number;
        scrollTop: number;
      }
    | undefined
  >(undefined);
  const armed = useRef(false);
  const start = useCallback(() => {
    const element = viewport.current;
    if (!element || loading) return;
    const top = element.getBoundingClientRect().top;
    const visible = [...element.querySelectorAll<HTMLElement>('[data-message-id]')].find(
      (message) => message.getBoundingClientRect().bottom > top,
    );
    if (visible)
      anchor.current = {
        id: visible.dataset.messageId!,
        first: element.querySelector<HTMLElement>('[data-message-id]')!.dataset.messageId!,
        entry: firstEntry,
        top: visible.getBoundingClientRect().top,
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
      };
    void loadOlder();
  }, [loading, loadOlder, firstEntry]);
  useEffect(() => {
    const element = viewport.current;
    if (!element || !hasOlder) return;
    let previous = element.scrollTop;
    const load = () => {
      if (!armed.current || element.scrollTop > 200 || loading || error || anchor.current) return;
      start();
    };
    const scroll = () => {
      if (element.scrollTop < previous) armed.current = true;
      previous = element.scrollTop;
      load();
    };
    const wheel = (event: WheelEvent) => {
      if (event.deltaY < 0) {
        armed.current = true;
        load();
      }
    };
    element.addEventListener('scroll', scroll, { passive: true });
    element.addEventListener('wheel', wheel, { passive: true });
    return () => {
      element.removeEventListener('scroll', scroll);
      element.removeEventListener('wheel', wheel);
    };
  }, [hasOlder, loading, error, start]);
  useLayoutEffect(() => {
    if (loading || !anchor.current) return;
    let frame = 0;
    const restore = () => {
      const element = viewport.current,
        saved = anchor.current;
      if (!element || !saved) return;
      // assistant-ui imports history in a passive effect. Wait for its message DOM,
      // otherwise removing the loading row can consume the compensation too early.
      if (
        !error &&
        firstEntry !== saved.entry &&
        element.querySelector<HTMLElement>('[data-message-id]')?.dataset.messageId === saved.first
      )
        return;
      const target = [...element.querySelectorAll<HTMLElement>('[data-message-id]')].find(
        (message) => message.dataset.messageId === saved.id,
      );
      if (target) element.scrollTop += target.getBoundingClientRect().top - saved.top;
      else if (!error)
        element.scrollTop = saved.scrollTop + element.scrollHeight - saved.scrollHeight;
      anchor.current = undefined;
      observer.disconnect();
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(restore);
    };
    const observer = new MutationObserver(schedule);
    if (viewport.current) observer.observe(viewport.current, { childList: true, subtree: true });
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [firstEntry, loading, error]);
  return { viewport, retry: start };
}
