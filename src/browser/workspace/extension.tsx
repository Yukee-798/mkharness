import { useLocale } from '../app/locale';
import { useEffect } from 'react';
import type { ToolCallMessagePartProps } from '@assistant-ui/react';
import type { BrowserExtension } from '../extensions/extensions';
import { useWorkspace } from './provider';
import { Button } from '../ui/button';
import { ArrowUpRight, Check, FileText, Layers, LoaderCircle } from 'lucide-react';

function plainText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function WorkspaceResult(part: ToolCallMessagePartProps) {
  const { t } = useLocale();
  const w = useWorkspace();
  let result: { command?: string; status?: string; objectIds?: string[] } | undefined;
  try {
    result =
      typeof part.result === 'string' ? JSON.parse(part.result) : (part.result as typeof result);
  } catch {
    /* Streaming result. */
  }
  const report = result?.command === 'report.publish' || part.args?.name === 'report.publish';
  const done = !!result?.status;
  const failed = part.isError || part.status.type === 'incomplete';
  const input = part.args?.input as { title?: unknown; summary?: unknown } | undefined;
  const title = plainText(input?.title) || t('未命名报告');
  const summary = plainText(input?.summary);
  const opened = part.status.type === 'running' && done;
  useEffect(() => {
    if (opened && report) w?.setOpen(true);
  }, [opened, report, w]);
  if (report) {
    return (
      <article
        className="my-2 flex w-full max-w-xl items-start gap-3 rounded-lg border bg-card p-3 text-card-foreground"
        data-slot="workspace-tool-result"
      >
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <FileText className="size-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="min-w-0 text-sm leading-5 font-semibold break-words">{title}</h3>
            <span
              className={`flex items-center gap-1 text-xs ${failed ? 'text-destructive' : 'text-muted-foreground'}`}
              role="status"
            >
              {failed ? (
                t('报告未保存，请查看回复说明')
              ) : done ? (
                <>
                  <Check className="size-3" aria-hidden="true" />
                  {t('已保存')}
                </>
              ) : (
                <>
                  <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
                  {t('正在生成报告…')}
                </>
              )}
            </span>
          </div>
          <p className="line-clamp-2 text-xs leading-5 break-words text-muted-foreground sm:line-clamp-1">
            {summary || t('打开报告查看完整内容，或下载 HTML 文件。')}
          </p>
        </div>
        {done && !failed && (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 self-center gap-1 px-2 text-xs"
            onClick={() => {
              if (result?.objectIds?.[0]) w?.openObject(result.objectIds[0]);
              else w?.setOpen(true);
            }}
          >
            {t('查看报告')}
            <ArrowUpRight className="size-3.5" aria-hidden="true" />
          </Button>
        )}
      </article>
    );
  }
  return (
    <div
      className="my-3 flex max-w-lg items-center gap-3 rounded-xl border bg-muted/20 p-4"
      data-slot="workspace-tool-result"
    >
      {done ? <Layers className="size-5" /> : <LoaderCircle className="size-4 animate-spin" />}
      <span className="min-w-0 flex-1 text-sm">
        {part.isError || part.status.type === 'incomplete'
          ? t('工作区操作未完成，请查看回复说明')
          : done
            ? result?.status === 'accepted'
              ? t('图片任务已提交，可在画布查看进度')
              : t('工作区已更新')
            : t('正在更新工作区…')}
      </span>
    </div>
  );
}
export const toolkit = {
  workspace_read: { type: 'backend', display: 'inline' },
  workspace_execute: { type: 'backend', display: 'standalone', render: WorkspaceResult },
} satisfies BrowserExtension['toolkit'];
