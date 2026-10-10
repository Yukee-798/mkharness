// Source: https://github.com/assistant-ui/assistant-ui/tree/main/apps/docs/components/pages/home/demo/trace.tsx
// Copyright (c) 2026 AgentbaseAI Inc. (MIT); see THIRD_PARTY_NOTICES.md.
// TraceLine: apps/docs/components/shared/trace-line.tsx; disclosure affordances adapted locally.
import type { ReactNode } from 'react';
import type { ComponentProps } from 'react';
import { ChevronRightIcon } from 'lucide-react';
import { ShimmerLabel } from './surfaces';
import { CollapsibleTrigger } from './ui/collapsible';
import { cn } from './ui/utils';

// The parent owns spacing between traces; all collapsed rows share the same height.
export const traceRowClass = 'flex items-center gap-2 py-1 leading-5';

// Keep space reserved when hidden so hover/focus never moves the label or source.
export function DisclosureChevron({
  className,
  ...props
}: ComponentProps<typeof ChevronRightIcon>): ReactNode {
  return (
    <ChevronRightIcon
      aria-hidden="true"
      data-slot="disclosure-chevron"
      className={cn(
        'size-3.5 shrink-0 opacity-0 transition-[opacity,rotate] duration-200 motion-reduce:transition-none',
        'group-hover/trigger:opacity-60 group-focus-visible/trigger:opacity-60',
        'group-data-open/trigger:opacity-60 group-data-panel-open/trigger:opacity-60',
        'group-data-open/trigger:rotate-90 group-data-panel-open/trigger:rotate-90',
        className,
      )}
      {...props}
    />
  );
}

export function TraceLine({
  live,
  label,
  detail,
  meta,
}: {
  live: boolean;
  label: string;
  detail?: string;
  meta?: string;
}): ReactNode {
  return (
    <div className={cn('font-mono text-[12px] [font-variant-ligatures:none]', traceRowClass)}>
      <span className="text-muted-foreground min-w-0 flex-1 truncate">
        {live ? (
          <ShimmerLabel>
            {label}
            {detail ? ` ${detail}` : null}
          </ShimmerLabel>
        ) : (
          <>
            {label}
            {detail ? ` ${detail}` : null}
          </>
        )}
      </span>
      {meta ? <span className="text-muted-foreground/50 shrink-0">{meta}</span> : null}
    </div>
  );
}
export const disclosureContentClass = 'border-foreground/10 ms-[5px] border-s ps-4';

export function DisclosureTrigger({
  live,
  label,
  detail,
  className,
  ...props
}: {
  live: boolean;
  label: string;
  detail?: string;
} & ComponentProps<typeof CollapsibleTrigger>): ReactNode {
  return (
    <CollapsibleTrigger
      data-slot="reasoning-trigger"
      className={cn(
        'group/trigger w-fit max-w-full text-left font-mono text-[12px] outline-none [font-variant-ligatures:none] focus-visible:underline',
        traceRowClass,
        className,
      )}
      {...props}
    >
      <span className="text-muted-foreground group-hover/trigger:text-foreground min-w-0 truncate transition-colors">
        {live ? (
          <ShimmerLabel>
            {label}
            {detail ? ` ${detail}` : null}
          </ShimmerLabel>
        ) : (
          <>
            {label}
            {detail ? ` ${detail}` : null}
          </>
        )}
      </span>
      <DisclosureChevron />
    </CollapsibleTrigger>
  );
}
