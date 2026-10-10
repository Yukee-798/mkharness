// Read-only presentation subset adapted from assistant-ui's MIT tool-fallback registry.
// Approval controls are omitted because this template does not expose client tool approval.
import { useCallback, useRef, useState } from 'react';
import { AlertCircleIcon, CheckIcon, ChevronDownIcon, LoaderIcon, XCircleIcon } from 'lucide-react';
import {
  useScrollLock,
  useToolCallElapsed,
  type ToolCallMessagePartStatus,
} from '@assistant-ui/react';
import { cn } from './ui/utils';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
const ANIMATION_DURATION = 200;

export type ToolFallbackRootProps = Omit<
  React.ComponentProps<typeof Collapsible>,
  'open' | 'onOpenChange'
> & {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
};

function ToolFallbackRoot({
  className,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultOpen = false,
  children,
  ...props
}: ToolFallbackRootProps) {
  const collapsibleRef = useRef<HTMLDivElement>(null);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const lockScroll = useScrollLock(collapsibleRef, ANIMATION_DURATION);

  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen;

  const handleOpenChange = useCallback(
    (open: boolean) => {
      lockScroll();
      if (!isControlled) {
        setUncontrolledOpen(open);
      }
      controlledOnOpenChange?.(open);
    },
    [lockScroll, isControlled, controlledOnOpenChange],
  );

  return (
    <Collapsible
      ref={collapsibleRef}
      data-slot="tool-fallback-root"
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={cn('aui-tool-fallback-root group/tool-fallback-root w-full', className)}
      style={
        {
          '--animation-duration': `${ANIMATION_DURATION}ms`,
        } as React.CSSProperties
      }
      {...props}
    >
      {children}
    </Collapsible>
  );
}

type ToolStatus = ToolCallMessagePartStatus['type'];

const statusIconMap: Record<ToolStatus, React.ElementType> = {
  running: LoaderIcon,
  complete: CheckIcon,
  incomplete: XCircleIcon,
  'requires-action': AlertCircleIcon,
};

const formatToolDuration = (ms: number) => {
  if (ms < 1000) return '<1s';
  const seconds = ms / 1000;
  if (seconds < 10) return `${(Math.floor(seconds * 10) / 10).toFixed(1)}s`;
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
};

function ToolFallbackDuration({ className, ...props }: React.ComponentProps<'span'>) {
  const elapsedMs = useToolCallElapsed();
  if (elapsedMs === undefined) return null;

  return (
    <span
      data-slot="tool-fallback-duration"
      className={cn(
        'aui-tool-fallback-duration shrink-0 text-muted-foreground text-xs whitespace-nowrap tabular-nums',
        className,
      )}
      {...props}
    >
      {formatToolDuration(elapsedMs)}
    </span>
  );
}

function ToolFallbackTrigger({
  toolName,
  target,
  status,
  className,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger> & {
  toolName: string;
  target?: string;
  status?: ToolCallMessagePartStatus;
}) {
  const statusType = status?.type ?? 'complete';
  const isRunning = statusType === 'running';
  const isCancelled = status?.type === 'incomplete' && status.reason === 'cancelled';

  const Icon = statusIconMap[statusType];
  const label =
    statusType === 'running'
      ? '正在执行'
      : statusType === 'requires-action'
        ? '等待处理'
        : statusType === 'incomplete'
          ? `${isCancelled ? '已停止' : '执行失败'}`
          : '已完成';

  return (
    <CollapsibleTrigger
      data-slot="tool-fallback-trigger"
      aria-label={`${label}：${toolName}${target ? ` · ${target}` : ''}`}
      className={cn(
        'aui-tool-fallback-trigger group/trigger text-muted-foreground hover:text-foreground flex w-fit max-w-full origin-left items-center gap-2 rounded-sm py-1.5 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        className,
      )}
      {...props}
    >
      <ChevronDownIcon
        aria-hidden="true"
        data-slot="tool-fallback-trigger-chevron"
        className="aui-tool-fallback-trigger-chevron size-3.5 shrink-0 -rotate-90 transition-transform duration-200 group-data-[state=open]/trigger:rotate-0 motion-reduce:transition-none"
      />
      <span
        data-slot="tool-fallback-trigger-label"
        className={cn(
          'aui-tool-fallback-trigger-label-wrapper shrink-0 text-start leading-5',
          isCancelled && 'text-muted-foreground line-through',
          isRunning && 'shimmer motion-reduce:animate-none',
        )}
      >
        {toolName}
      </span>
      {target && (
        <span className="min-w-0 truncate rounded-md bg-muted px-1.5 py-0.5 text-xs" title={target}>
          {target}
        </span>
      )}
      <ToolFallbackDuration />
      <Icon
        aria-hidden="true"
        data-slot="tool-fallback-trigger-icon"
        className={cn(
          'aui-tool-fallback-trigger-icon size-3.5 shrink-0',
          statusType === 'complete' && 'text-emerald-600 dark:text-emerald-400',
          statusType === 'incomplete' && !isCancelled && 'text-destructive',
          isRunning && 'motion-safe:animate-spin',
        )}
      />
    </CollapsibleTrigger>
  );
}

function ToolFallbackContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      data-slot="tool-fallback-content"
      className={cn(
        'aui-tool-fallback-content relative overflow-hidden text-sm outline-none',
        'group/collapsible-content ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none',
        'data-closed:animate-collapsible-up',
        'data-open:animate-collapsible-down',
        'data-closed:fill-mode-forwards',
        'data-closed:pointer-events-none',
        '[--tw-duration:var(--animation-duration)]',
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          'flex flex-col gap-2 ps-6 pt-1 pb-2 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none',
          'group-data-open/collapsible-content:animate-in group-data-open/collapsible-content:fade-in-0 group-data-open/collapsible-content:blur-in-[2px] group-data-open/collapsible-content:slide-in-from-top-1',
          'group-data-closed/collapsible-content:animate-out group-data-closed/collapsible-content:fade-out-0 group-data-closed/collapsible-content:blur-out-[2px] group-data-closed/collapsible-content:slide-out-to-top-1',
          'group-data-closed/collapsible-content:animation-duration-(--animation-duration) group-data-open/collapsible-content:animation-duration-(--animation-duration)',
        )}
      >
        {children}
      </div>
    </CollapsibleContent>
  );
}

function ToolFallbackArgs({
  argsText,
  className,
  ...props
}: React.ComponentProps<'div'> & {
  argsText?: string;
}) {
  if (!argsText) return null;

  return (
    <div
      data-slot="tool-fallback-args"
      className={cn('aui-tool-fallback-args', className)}
      {...props}
    >
      <pre className="aui-tool-fallback-args-value bg-muted/50 text-foreground/90 rounded-md p-2.5 text-xs break-words whitespace-pre-wrap">
        {argsText}
      </pre>
    </div>
  );
}

const formatUnknownValue = (value: unknown, space?: number): string => {
  if (typeof value === 'string') return value;

  try {
    if (value instanceof Error) return String(value);

    const json = JSON.stringify(value, null, space);
    if (json !== undefined) return json;
  } catch {
    // Fall through to a readable value when the tool result is not JSON-serializable.
  }

  try {
    return String(value);
  } catch {
    return '[Unserializable value]';
  }
};

function ToolFallbackResult({
  result,
  className,
  ...props
}: React.ComponentProps<'div'> & {
  result?: unknown;
}) {
  if (result === undefined) return null;

  return (
    <div
      data-slot="tool-fallback-result"
      className={cn('aui-tool-fallback-result', className)}
      {...props}
    >
      <p className="aui-tool-fallback-result-header text-muted-foreground text-xs font-medium">
        结果：
      </p>
      <pre className="aui-tool-fallback-result-content bg-muted/50 text-foreground/90 mt-1 rounded-md p-2.5 text-xs break-words whitespace-pre-wrap">
        {formatUnknownValue(result, 2)}
      </pre>
    </div>
  );
}

function ToolFallbackError({
  status,
  className,
  ...props
}: React.ComponentProps<'div'> & {
  status?: ToolCallMessagePartStatus;
}) {
  if (status?.type !== 'incomplete') return null;

  const error = status.error;
  const errorText = error === undefined || error === null ? null : formatUnknownValue(error);

  if (!errorText) return null;

  const isCancelled = status.reason === 'cancelled';
  const headerText = isCancelled ? '停止原因：' : '错误：';

  return (
    <div
      data-slot="tool-fallback-error"
      className={cn('aui-tool-fallback-error', className)}
      {...props}
    >
      <p className="aui-tool-fallback-error-header text-muted-foreground font-semibold">
        {headerText}
      </p>
      <p className="aui-tool-fallback-error-reason text-muted-foreground break-words whitespace-pre-line">
        {errorText}
      </p>
    </div>
  );
}

export {
  ToolFallbackRoot,
  ToolFallbackTrigger,
  ToolFallbackContent,
  ToolFallbackArgs,
  ToolFallbackResult,
  ToolFallbackError,
};
