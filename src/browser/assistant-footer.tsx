import { useLocale } from './locale';
import { ActionBarPrimitive, ActionBarMorePrimitive, useAuiState } from '@assistant-ui/react';
import { Copy, Check, Download, Ellipsis } from 'lucide-react';
import { TooltipIconButton } from './tooltip-icon-button';
import { AssistantFooterExtensions, AssistantActionExtensions } from './extension-ui';

/** Official assistant-ui message actions; HTTP submission and SSE attachment stay separate. */
export function AssistantFooter() {
  const { t } = useLocale();
  const visible = useAuiState((s) => {
    if (s.message.status?.type === 'running') return false;
    const index = s.thread.messages.findIndex((message) => message.id === s.message.id);
    if (index < 0) return false;
    const following = s.thread.messages.slice(index + 1);
    const boundary = following.findIndex((message) => message.role === 'user');
    const reply = boundary < 0 ? following : following.slice(0, boundary);
    return (
      !reply.some((message) => message.role === 'assistant') &&
      (boundary >= 0 || !s.thread.isRunning)
    );
  });
  if (!visible) return null;
  return (
    <div
      data-slot="assistant-footer"
      className="mt-1 flex flex-col items-start gap-1.5 text-xs text-muted-foreground"
    >
      <ActionBarPrimitive.Root autohide="never" className="flex items-center gap-1">
        <ActionBarPrimitive.Copy asChild>
          <TooltipIconButton tooltip={t('复制回复')} className="group/copy size-7">
            <Copy className="size-4 group-data-[copied]/copy:hidden" />
            <Check className="hidden size-4 group-data-[copied]/copy:block" />
          </TooltipIconButton>
        </ActionBarPrimitive.Copy>
        <AssistantActionExtensions />
        <ActionBarMorePrimitive.Root>
          <ActionBarMorePrimitive.Trigger asChild>
            <TooltipIconButton tooltip={t('更多操作')} className="size-7">
              <Ellipsis className="size-4" />
            </TooltipIconButton>
          </ActionBarMorePrimitive.Trigger>
          <ActionBarMorePrimitive.Content
            align="start"
            side="bottom"
            className="z-50 min-w-44 rounded-lg border bg-popover p-1 text-sm text-popover-foreground shadow-md"
          >
            <ActionBarMorePrimitive.Item asChild>
              <ActionBarPrimitive.ExportMarkdown className="flex w-full items-center gap-2 rounded-md px-3 py-2 outline-none hover:bg-muted focus:bg-muted disabled:opacity-50">
                <Download className="size-4" />
                {t('导出为 Markdown')}
              </ActionBarPrimitive.ExportMarkdown>
            </ActionBarMorePrimitive.Item>
          </ActionBarMorePrimitive.Content>
        </ActionBarMorePrimitive.Root>
      </ActionBarPrimitive.Root>
      <AssistantFooterExtensions />
    </div>
  );
}
