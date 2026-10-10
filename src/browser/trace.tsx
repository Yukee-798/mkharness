// Source: https://github.com/assistant-ui/assistant-ui/tree/main/apps/docs/components/pages/home/demo/trace.tsx
// Copyright (c) 2026 AgentbaseAI Inc. (MIT); see THIRD_PARTY_NOTICES.md.
// TraceMarker and TraceLine: apps/docs/components/shared/trace-line.tsx.
import type { ReactNode } from 'react';
import type { ComponentProps } from 'react';
import { ShimmerLabel } from './surfaces';
import { CollapsibleTrigger } from './ui/collapsible';
import { cn } from './ui/utils';

/**
 * The mark every trace line carries. A disclosure rotates it and a plain line
 * does not, so the two read as the same grammar rather than two symbols; it
 * stays a glyph rather than an icon because an icon on a line that cannot open
 * reads as an affordance.
 */
export function TraceMarker({ live, className }: { live: boolean; className?: string }): ReactNode {
  return (
    <span
      aria-hidden
      data-slot="trace-marker"
      className={cn(
        'inline-block shrink-0 transition-transform',
        live ? 'text-blue-500' : 'text-muted-foreground/50',
        className,
      )}
    >
      {'>'}
    </span>
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
    <div className="my-1 flex items-baseline gap-2 font-mono text-[12px] [font-variant-ligatures:none]">
      <TraceMarker live={live} />
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
  ...props
}: {
  live: boolean;
  label: string;
  detail?: string;
} & ComponentProps<typeof CollapsibleTrigger>): ReactNode {
  return (
    <CollapsibleTrigger
      data-slot="reasoning-trigger"
      className="group/trigger my-1 flex max-w-full items-baseline gap-2 text-left font-mono text-[12px] outline-none [font-variant-ligatures:none] focus-visible:underline"
      {...props}
    >
      <TraceMarker
        live={live}
        className="group-data-open/trigger:rotate-90 group-data-panel-open/trigger:rotate-90"
      />
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
    </CollapsibleTrigger>
  );
}
