import { useLocale } from '../../browser/app/locale';
import { useAuiState, type ToolCallMessagePartProps } from '@assistant-ui/react';
import type { BrowserExtension } from '../../browser/extensions/extensions';
import { useExtensionContext } from '../../browser/extensions/extension-context';
import { Panel } from './Panel';
import { partialUI } from './partial';
import { useToolProgress } from '../../browser/chat/messages/tool-progress';
import { useEffect, useRef } from 'react';
import { Button } from '../../browser/ui/button';
import { FileText, ArrowUpRight } from 'lucide-react';
import { useWorkbench } from '../../browser/workbench/panel-host';
import { previewPanel } from './WorkbenchPanel';
function Present(part: ToolCallMessagePartProps) {
  const { t } = useLocale();
  const { id, userId, submit } = useExtensionContext();
  const progress = useToolProgress(part.toolCallId);
  const workbench = useWorkbench();
  const stableKey = useRef(part.toolCallId);
  const running = useAuiState((state) => state.thread.isRunning);
  const terminalFailure = useAuiState((state) => {
    const messages = state.thread.messages;
    const index = messages.findIndex((message) => message.id === state.message.id);
    if (index < 0) return false;
    const nextUser = messages.findIndex((message, i) => i > index && message.role === 'user');
    const end = nextUser < 0 ? messages.length : nextUser;
    let lastCall;
    for (const message of messages.slice(index, end))
      for (const content of message.content)
        if (content.type === 'tool-call' && content.toolName === 'present_openui')
          lastCall = content.toolCallId;
    // Repairs belong to this response; a later user turn must not erase its unresolved failure.
    return lastCall === part.toolCallId && (nextUser >= 0 || !state.thread.isRunning);
  });
  const preview = typeof part.args?.ui === 'string' ? part.args.ui : partialUI(part.argsText ?? '');
  let result = part.result;
  if (typeof result === 'string') {
    try {
      result = JSON.parse(result);
    } catch {
      result = undefined;
    }
  }
  const reference =
    result && typeof result === 'object' && 'panelRef' in result ? result.panelRef : undefined;
  const panelRef = typeof reference === 'string' ? reference : undefined;
  const failed = part.isError || progress?.status === 'failed' || part.status.type === 'incomplete';
  const failure = failed
    ? part.status.type === 'incomplete' && part.status.reason === 'cancelled'
      ? '内容生成已停止。'
      : '内容暂时无法生成。可以调整需求再试一次。'
    : undefined;
  useEffect(() => {
    if (!workbench) return;
    const target = {
      key: stableKey.current,
      ...(panelRef ? { ref: panelRef } : {}),
      ...(preview ? { preview } : {}),
      ...(failure ? { failure } : {}),
    };
    workbench.updatePanel('openui/preview', target);
    if (!failed && running && part.status.type === 'running' && preview)
      workbench.openPanel({ type: 'openui/preview', target, activation: 'suggested' });
  }, [workbench, panelRef, preview, failure, failed, running, part.status.type]);
  if (workbench && (panelRef || preview || failure))
    return (
      <Button
        variant="outline"
        className="h-auto w-full justify-start gap-3 whitespace-normal px-4 py-3 text-left"
        disabled={failed && !terminalFailure}
        onClick={() =>
          workbench.openPanel({
            type: 'openui/preview',
            target: {
              key: stableKey.current,
              ...(panelRef ? { ref: panelRef } : {}),
              ...(preview ? { preview } : {}),
              ...(failure ? { failure } : {}),
            },
            activation: 'explicit',
          })
        }
      >
        <FileText className="size-4 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block">{t('Interactive answer')}</span>
          <span className="block text-xs font-normal text-muted-foreground">
            {failure ? t(failure) : panelRef ? t('在工作面板中打开') : t('正在生成预览…')}
          </span>
        </span>
        <ArrowUpRight className="size-4 shrink-0" />
      </Button>
    );
  if (part.isError || progress?.status === 'failed' || part.status.type === 'incomplete')
    return terminalFailure ? (
      <p role="alert">
        {part.status.type === 'incomplete' && part.status.reason === 'cancelled'
          ? t('内容生成已停止。')
          : t('内容暂时无法生成。可以调整需求再试一次。')}
      </p>
    ) : null;
  return panelRef || preview ? (
    <Panel
      conversationId={id}
      userId={userId}
      panelRef={panelRef}
      preview={preview}
      submit={submit}
    />
  ) : null;
}
export const toolkit = {
  prepare_program: { type: 'backend', render: () => null },
  present_openui: { type: 'backend', render: Present, display: 'standalone' },
} satisfies BrowserExtension['toolkit'];
export const activity = { prepare_program: 'hidden' } satisfies BrowserExtension['activity'];
export const panels = { preview: previewPanel } satisfies BrowserExtension['panels'];
