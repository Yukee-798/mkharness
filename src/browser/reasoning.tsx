// Streaming disclosure adapted from assistant-ui's MIT reasoning / reasoning.aui elements.
// Uses the existing shadcn Collapsible and assistant-ui scroll locking with our theme tokens.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useScrollLock } from '@assistant-ui/react';
import { BrainIcon, ChevronDownIcon } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import { cn } from './ui/utils';

export function Reasoning({ active, children }: { active: boolean; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? active;
  const lockScroll = useScrollLock(root, 200);
  const lastActive = useRef(active);
  useLayoutEffect(() => {
    if (lastActive.current !== active && userOpen === null) lockScroll();
    lastActive.current = active;
  }, [active, userOpen, lockScroll]);
  const toggle = useCallback(
    (next: boolean) => {
      lockScroll();
      setUserOpen(next);
    },
    [lockScroll],
  );
  useEffect(() => {
    if (!active || !open || !viewport.current || !content.current) return;
    const element = viewport.current;
    let pinned = true;
    let lastTop = element.scrollTop;
    let lastHeight = element.scrollHeight;
    const pin = () => {
      if (pinned) element.scrollTop = element.scrollHeight;
    };
    const onScroll = () => {
      if (element.scrollHeight - element.scrollTop - element.clientHeight <= 1) pinned = true;
      else if (element.scrollTop < lastTop && element.scrollHeight === lastHeight) pinned = false;
      lastTop = element.scrollTop;
      lastHeight = element.scrollHeight;
    };
    pin();
    element.addEventListener('scroll', onScroll);
    const observer = new ResizeObserver(pin);
    observer.observe(content.current);
    return () => {
      observer.disconnect();
      element.removeEventListener('scroll', onScroll);
    };
  }, [active, open]);
  return (
    <Collapsible
      ref={root}
      open={open}
      onOpenChange={toggle}
      data-slot="reasoning-root"
      className="aui-reasoning-root group/reasoning-root w-full rounded-lg border px-3 py-2"
    >
      <CollapsibleTrigger
        data-slot="reasoning-trigger"
        className="aui-reasoning-trigger flex max-w-full items-center gap-2 rounded-sm py-1 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <BrainIcon className="size-4 shrink-0" aria-hidden="true" />
        <span>{active ? '正在思考…' : '思考过程'}</span>
        <ChevronDownIcon
          aria-hidden="true"
          className={cn(
            'size-3.5 shrink-0 transition-transform motion-reduce:transition-none',
            !open && '-rotate-90',
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent data-slot="reasoning-content" aria-busy={active}>
        <div
          ref={viewport}
          data-slot="reasoning-text"
          className="aui-reasoning-text max-h-48 overflow-y-auto overscroll-contain pt-2 pl-6 text-sm leading-relaxed text-muted-foreground"
        >
          <div ref={content} className="space-y-3">
            {children}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
