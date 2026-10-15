import { useLocale } from './locale';
import { useState, type ReactNode } from 'react';
import type { ToolCallMessagePartProps } from '@assistant-ui/react';
import { Wrench, CircleMinus, XCircle, AlertCircle } from 'lucide-react';
import { ToolCall } from './tool-call';
import { useToolProgress } from './tool-progress';
import { ToolTitleMeta, ToolFooterExtensions, useToolDisplayName } from './extension-ui';
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
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const progress = useToolProgress(part.toolCallId);
  const toolName = useToolDisplayName(part.toolName);
  const name = labels ?? {
    active: t('正在执行：{tool}', { tool: toolName }),
    complete: t('已完成：{tool}', { tool: toolName }),
    failed: t('执行失败：{tool}', { tool: toolName }),
  };
  const running =
    progress?.status === 'failed' || progress?.status === 'complete'
      ? false
      : part.status?.type === 'running';
  const cancelled = part.status?.type === 'incomplete' && part.status.reason === 'cancelled';
  const failed =
    progress?.status === 'failed' ||
    part.isError ||
    (part.status?.type === 'incomplete' && !cancelled);
  const waiting = part.status?.type === 'requires-action';
  const label = cancelled
    ? t('已停止')
    : failed
      ? name.failed
      : waiting
        ? t('等待处理')
        : name.complete;
  const query = displayQuery ?? '';
  const result =
    part.result ?? (part.status?.type === 'incomplete' ? part.status.error : undefined);
  return (
    <>
      <ToolCall
        label={label}
        activeLabel={name.active}
        query={query}
        titleMeta={<ToolTitleMeta part={part} />}
        request={part.argsText ?? ''}
        result={typeof result === 'string' ? result : (JSON.stringify(result, null, 2) ?? '')}
        progress={
          progress?.value !== undefined
            ? JSON.stringify(progress.value, null, 2)
            : progress?.truncated
              ? t('进度内容超过显示上限')
              : undefined
        }
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
      <ToolFooterExtensions part={part} />
    </>
  );
}
