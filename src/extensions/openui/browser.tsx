import { useAuiState, type ToolCallMessagePartProps } from '@assistant-ui/react';
import type { BrowserExtension } from '../../browser/extensions';
import { useExtensionContext } from '../../browser/extension-context';
import { Panel } from './Panel';
import { partialUI } from './partial';
function Present(part: ToolCallMessagePartProps) {
  const { id, userId, submit } = useExtensionContext();
  const final = useAuiState((state) => state.message.isLast && !state.thread.isRunning);
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
  if (part.isError)
    return final ? <p role="alert">内容暂时无法生成。可以调整需求再试一次。</p> : null;
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
