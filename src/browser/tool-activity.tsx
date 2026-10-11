import { useState, type ReactNode } from 'react';
import type { ToolCallMessagePartProps } from '@assistant-ui/react';
import { Wrench, CircleMinus, XCircle, AlertCircle } from 'lucide-react';
import { ToolCall } from './tool-call';
export function ToolActivity({
  part,
  labels,
  icon,
  query: displayQuery,
}: {
  part: ToolCallMessagePartProps;
  labels?: { active: string; complete: string; failed: string };
  icon?: ReactNode;
  query?: string;
}) {
  const [open, setOpen] = useState(false);
  const name = labels ?? {
    active: `正在执行：${part.toolName}`,
    complete: `已完成：${part.toolName}`,
    failed: `执行失败：${part.toolName}`,
  };
  const running = part.status?.type === 'running';
  const cancelled = part.status?.type === 'incomplete' && part.status.reason === 'cancelled';
  const failed = part.isError || (part.status?.type === 'incomplete' && !cancelled);
  const waiting = part.status?.type === 'requires-action';
  const label = cancelled ? '已停止' : failed ? name.failed : waiting ? '等待处理' : name.complete;
  const query = displayQuery ?? '';
  const result =
    part.result ?? (part.status?.type === 'incomplete' ? part.status.error : undefined);
  return (
    <ToolCall
      label={label}
      activeLabel={name.active}
      query={query}
      request={part.argsText ?? ''}
      result={typeof result === 'string' ? result : (JSON.stringify(result, null, 2) ?? '')}
      running={running}
      icon={icon ?? <Wrench />}
      open={open}
      onOpenChange={setOpen}
      ariaLabel={`${running ? name.active : label}${query ? ` · ${query}` : ''}`}
      statusIcon={
        cancelled ? (
          <CircleMinus className="size-3.5 text-muted-foreground" />
        ) : failed ? (
          <XCircle className="size-3.5 text-destructive" />
        ) : waiting ? (
          <AlertCircle className="size-3.5 text-muted-foreground" />
        ) : undefined
      }
    />
  );
}
