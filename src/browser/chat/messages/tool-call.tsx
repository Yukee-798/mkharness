'use client';
import { useLocale } from '../../app/locale';
// Compose the official assistant-ui ToolFallback display primitives and disclosure style.
// Sources: https://r.assistant-ui.com/tool-fallback.json and the homepage trace.tsx.
// Copyright (c) 2026 AgentbaseAI Inc. (MIT); see THIRD_PARTY_NOTICES.md.

import type { ReactNode } from 'react';
import { CollapsibleTrigger } from '../../ui/collapsible';
import { ShimmerLabel } from './surfaces';
import { DisclosureChevron, traceRowClass } from './trace';
import { cn } from '../../ui/utils';
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
  progress?: string;
  running: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  icon: ReactNode;
  statusIcon?: ReactNode;
  ariaLabel: string;
  titleMeta?: ReactNode;
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
  progress,
  running,
  open,
  onOpenChange,
  icon,
  statusIcon,
  ariaLabel,
  titleMeta,
}: ToolCallProps) {
  const { t } = useLocale();
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
        {query && <span className="min-w-0 truncate text-muted-foreground/70">{query}</span>}
        <DisclosureChevron data-slot="tool-call-chevron" />
        {titleMeta}
      </CollapsibleTrigger>
      <ToolFallbackContent>
        {progress && (
          <pre aria-label={t('工具进度')} tabIndex={0} className={payloadScroll}>
            {progress}
          </pre>
        )}
        <p className="text-xs text-muted-foreground">{t('请求参数')}</p>
        <ToolFallbackArgs
          argsText={request}
          scrollClassName={payloadScroll}
          scrollLabel={t('请求参数内容')}
        />
        <ToolFallbackResult
          result={result}
          scrollClassName={payloadScroll}
          scrollLabel={t('工具结果内容')}
        />
      </ToolFallbackContent>
    </ToolFallbackRoot>
  );
}
