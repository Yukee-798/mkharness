// Compose the official assistant-ui ToolFallback display primitives and disclosure style.
// Sources: https://r.assistant-ui.com/tool-fallback.json and the homepage trace.tsx.
// Copyright (c) 2026 AgentbaseAI Inc. (MIT); see THIRD_PARTY_NOTICES.md.
'use client';

import type { ReactNode } from 'react';
import { ChevronRightIcon } from 'lucide-react';
import { CollapsibleTrigger } from './ui/collapsible';
import { ShimmerLabel } from './surfaces';
import { traceRowClass } from './trace';
import { cn } from './ui/utils';
import {
  ToolFallbackRoot,
  ToolFallbackContent,
  ToolFallbackArgs,
  ToolFallbackResult,
} from './tool-fallback';

export interface ToolCallProps {
  label: string;
  activeLabel: string;
  query: string;
  request: string;
  result: string;
  running: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  icon: ReactNode;
  statusIcon?: ReactNode;
  ariaLabel: string;
}

// Each payload scrolls independently; the labels and other tools remain visible.
const payloadScroll =
  'max-h-44 overflow-auto overscroll-contain whitespace-pre-wrap wrap-anywhere sm:max-h-64 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50';

export function ToolCall({
  label,
  activeLabel,
  query,
  request,
  result,
  running,
  open,
  onOpenChange,
  icon,
  statusIcon,
  ariaLabel,
}: ToolCallProps) {
  return (
    <ToolFallbackRoot data-slot="tool-call" open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger
        aria-label={ariaLabel}
        className={cn(
          'group/trigger w-fit max-w-full rounded-md text-[13.5px] text-muted-foreground transition-colors outline-none hover:text-foreground/90 focus-visible:ring-1 focus-visible:ring-ring/50',
          traceRowClass,
        )}
      >
        <span aria-hidden="true" className="shrink-0 [&>svg]:size-4">
          {statusIcon ?? icon}
        </span>
        <ShimmerLabel active={running} className="shrink-0 font-mono">
          {running ? activeLabel : label}
        </ShimmerLabel>
        <span className="min-w-0 truncate text-muted-foreground/70">{query}</span>
        <ChevronRightIcon
          data-slot="tool-call-chevron"
          className="size-3.5 shrink-0 opacity-60 transition-transform duration-200 group-data-open/trigger:rotate-90 motion-reduce:transition-none"
        />
      </CollapsibleTrigger>
      <ToolFallbackContent>
        <p className="text-xs text-muted-foreground">请求参数</p>
        <ToolFallbackArgs
          argsText={request}
          scrollClassName={payloadScroll}
          scrollLabel="请求参数内容"
        />
        <ToolFallbackResult
          result={result}
          scrollClassName={payloadScroll}
          scrollLabel="工具结果内容"
        />
      </ToolFallbackContent>
    </ToolFallbackRoot>
  );
}
