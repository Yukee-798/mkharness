// Source: https://r.assistant-ui.com/elements-surfaces.json
// Copyright (c) 2026 AgentbaseAI Inc. (MIT); see THIRD_PARTY_NOTICES.md.
'use client';

import type { ComponentProps } from 'react';
import { cn } from '../../ui/utils';

export const paper = 'bg-background border border-border/60 dark:bg-popover';

export const field = 'bg-foreground/[0.04] forced-colors:border dark:bg-foreground/[0.06]';

export const fieldInteractive =
  'bg-foreground/[0.04] transition-colors hover:bg-foreground/[0.07] forced-colors:border dark:bg-foreground/[0.06] dark:hover:bg-foreground/[0.09]';

export const collapsePanel =
  'h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] data-[ending-style]:h-0 data-[starting-style]:h-0 motion-reduce:transition-none';

export const mono = 'font-mono text-[11px] tracking-tight';

export function ShimmerLabel({
  active = true,
  className,
  ...props
}: ComponentProps<'span'> & { active?: boolean }) {
  return (
    <span className={cn(active && 'shimmer motion-reduce:animate-none', className)} {...props} />
  );
}
