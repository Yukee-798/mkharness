import { useLocale } from '../../browser/locale';
import { useAuiState, type ToolCallMessagePartProps } from '@assistant-ui/react';
import type { BrowserExtension } from '../../browser/extensions';
import { useExtensionContext } from '../../browser/extension-context';
import { Panel } from './Panel';
import { partialUI } from './partial';
import { useToolProgress } from '../../browser/tool-progress';
function Present(part: ToolCallMessagePartProps) {
  const { t } = useLocale();
  const { id, userId, submit } = useExtensionContext();
  const progress = useToolProgress(part.toolCallId);
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
