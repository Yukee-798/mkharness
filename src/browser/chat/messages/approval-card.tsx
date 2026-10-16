'use client';
// Adapted from https://r.assistant-ui.com/elements-approval-card.json
// Copyright (c) 2026 AgentbaseAI Inc. (MIT); see THIRD_PARTY_NOTICES.md.

import { useId, type ComponentProps, type ReactNode } from 'react';
import { CheckIcon, Loader2Icon, TerminalIcon, XIcon } from 'lucide-react';
import { cn } from '../../ui/utils';
import { Button } from '../../ui/button';
import { field, mono, paper } from './surfaces';
import { useReceiptFocus } from './receipt-focus';

export type ApprovalState = 'request' | 'running' | 'done' | 'denied';

const receiptText: Record<Exclude<ApprovalState, 'request'>, string> = {
  running: 'Approved, running',
  done: 'Finished',
  denied: 'Denied',
};

export function ApprovalCard({
  state,
  command,
  title,
  subtitle,
  description,
  details,
  variant = 'default',
  icon,
  onAllowOnce,
  onAlwaysAllow,
  onDeny,
  allowOnceLabel = 'Allow once',
  alwaysAllowLabel = 'Always allow',
  denyLabel = 'Deny',
  statusLabel,
  disabled = false,
  className,
  ...props
}: Omit<
  ComponentProps<'div'>,
  | 'children'
  | 'state'
  | 'command'
  | 'title'
  | 'subtitle'
  | 'description'
  | 'details'
  | 'variant'
  | 'icon'
  | 'onAllowOnce'
  | 'onAlwaysAllow'
  | 'onDeny'
  | 'allowOnceLabel'
  | 'alwaysAllowLabel'
  | 'denyLabel'
  | 'statusLabel'
> & {
  state: ApprovalState;
  disabled?: boolean;
  command?: string | undefined;
  title: string;
  subtitle: string;
  description?: string | undefined;
  details?: readonly { label: string; value: string }[] | undefined;
  variant?: 'default' | 'destructive' | undefined;
  icon?: ReactNode | undefined;
  onAllowOnce?: (() => void) | undefined;
  onAlwaysAllow?: (() => void) | undefined;
  onDeny?: (() => void) | undefined;
  allowOnceLabel?: string | undefined;
  alwaysAllowLabel?: string | undefined;
  denyLabel?: string | undefined;
  statusLabel?: string | undefined;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const { receiptRef, focusHandlers } = useReceiptFocus<HTMLDivElement>(props);

  return (
    <div
      {...props}
      {...focusHandlers}
      role="group"
      data-variant={variant}
      data-slot="approval-card"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      className={cn(paper, 'flex w-full max-w-sm flex-col gap-3.5 rounded-[20px] p-4', className)}
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-xl',
            variant === 'destructive'
              ? 'bg-red-600/10 text-red-600 dark:bg-red-400/10 dark:text-red-400'
              : 'bg-foreground/[0.05] text-muted-foreground',
          )}
        >
          {icon ?? <TerminalIcon className="size-4" />}
        </span>
        <div className="flex min-w-0 flex-col">
          <p id={titleId} className="break-words text-[13.5px] font-medium">
            {title}
          </p>
          <p className="text-muted-foreground text-xs">{subtitle}</p>
        </div>
      </div>

      {description ? (
        <p id={descriptionId} className="text-foreground/60 text-[13px]">
          {description}
        </p>
      ) : null}

      {command ? (
        <pre
          className={cn(
            field,
            'max-h-64 overflow-auto whitespace-pre-wrap break-all text-foreground/70 rounded-xl px-3.5 py-2.5 font-mono text-xs',
          )}
        >
          {command}
        </pre>
      ) : null}

      {details?.length ? (
        <dl className={cn(field, 'flex flex-col gap-2 rounded-xl px-3.5 py-2.5')}>
          {details.map((detail, index) => (
            <div
              key={`${detail.label}-${index}`}
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-4 text-xs"
            >
              <dt className={cn(mono, 'text-muted-foreground')}>{detail.label}</dt>
              <dd className="text-foreground/80 break-words">{detail.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <div className="flex min-h-8 flex-wrap items-center justify-end gap-2">
        {state === 'request' ? (
          <>
            {onDeny && (
              <Button
                type="button"
                disabled={disabled}
                variant="ghost"
                data-slot="approval-card-deny"
                onClick={onDeny}
                className={cn('h-8 px-3.5 text-xs font-medium whitespace-nowrap')}
              >
                {denyLabel}
              </Button>
            )}
            {onAlwaysAllow && (
              <Button
                type="button"
                disabled={disabled}
                variant="ghost"
                data-slot="approval-card-always-allow"
                onClick={onAlwaysAllow}
                className={cn('h-8 px-3.5 text-xs font-medium whitespace-nowrap')}
              >
                {alwaysAllowLabel}
              </Button>
            )}
            {onAllowOnce && (
              <Button
                type="button"
                disabled={disabled}
                variant={variant === 'destructive' ? 'destructive' : 'default'}
                data-slot="approval-card-allow-once"
                onClick={onAllowOnce}
                className={cn(
                  'flex h-8 items-center rounded-full px-3.5 text-xs font-medium whitespace-nowrap',
                )}
              >
                {allowOnceLabel}
              </Button>
            )}
          </>
        ) : (
          <div
            key={state}
            ref={receiptRef}
            tabIndex={-1}
            role="status"
            className="fade-in animate-in text-muted-foreground flex items-center gap-2 text-xs duration-300 motion-reduce:animate-none"
          >
            {state === 'running' ? (
              <>
                <Loader2Icon className="text-muted-foreground size-3.5 animate-spin motion-reduce:animate-none" />
                {statusLabel ?? receiptText.running}
              </>
            ) : state === 'denied' ? (
              <>
                <XIcon className="text-muted-foreground size-3.5" />
                {statusLabel ?? receiptText.denied}
              </>
            ) : (
              <>
                <CheckIcon className="size-3.5 text-emerald-500" />
                {statusLabel ?? receiptText.done}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
