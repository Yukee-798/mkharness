import { useRef, useState, type MouseEvent } from 'react';
import { ActionBarPrimitive, ThreadPrimitive, useAuiState } from '@assistant-ui/react';
import { RefreshCw, LoaderCircle } from 'lucide-react';
import { canonicalMessageId, useExtensionContext } from '../../browser/extension-context';
import { useLocale } from '../../browser/locale';
import { Button } from '../../browser/ui/button';
import { TooltipIconButton } from '../../browser/tooltip-icon-button';
import type { RunCommand } from '../../shared/contracts';
import type { BrowserExtension } from '../../browser/extensions';

function useReplyAction() {
  const { submit, busy } = useExtensionContext();
  const running = useAuiState((s) => s.thread.isRunning);
  const sending = useRef(false);
  const [pending, setPending] = useState(false);
  return {
    pending,
    disabled: pending || !!busy || running,
    async send(event: MouseEvent, text: string, source?: RunCommand['source']) {
      // The host owns HTTP admission. Native send/reload would start a second,
      // attach-only AG-UI run. Public event cancellation keeps that boundary intact.
      event.preventDefault();
      if (sending.current || busy || running) return;
      sending.current = true;
      setPending(true);
      try {
        await submit(text, source);
      } catch {
        // The existing submission receipt displays the failure and retries the same runId.
      } finally {
        sending.current = false;
        setPending(false);
      }
    },
  };
}

function Regenerate() {
  const { t } = useLocale();
  const { messageIds } = useExtensionContext();
  const id = useAuiState((s) => s.message.id);
  const canonical = canonicalMessageId(id, messageIds).split(':')[0]!;
  const action = useReplyAction();
  if (!/^[1-9]\d*$/.test(canonical)) return null;
  return (
    <ActionBarPrimitive.Reload
      asChild
      disabled={action.disabled}
      onClick={(event) =>
        void action.send(event, t('重新生成回复'), {
          action: 'extension_action',
          extensionId: 'reply',
          name: 'regenerate',
          payload: { entryId: canonical },
        })
      }
    >
      <TooltipIconButton tooltip={t('重新生成回复')} className="size-7">
        {action.pending ? (
          <LoaderCircle className="size-4 motion-safe:animate-spin" />
        ) : (
          <RefreshCw className="size-4" />
        )}
      </TooltipIconButton>
    </ActionBarPrimitive.Reload>
  );
}

/** Native suggestion chips. No second model request or writable suggestion store. */
function FollowupSuggestions() {
  const { t } = useLocale();
  const latest = useAuiState((s) => s.thread.messages.at(-1)?.id === s.message.id);
  const action = useReplyAction();
  if (!latest || action.disabled) return null;
  const suggestions = ['总结这段回答', '举一个具体例子', '接下来可以做什么'].map((text) => t(text));
  return (
    <div data-slot="suggestions" className="mt-3 flex w-full flex-wrap gap-2">
      {suggestions.map((prompt) => (
        <ThreadPrimitive.Suggestion
          key={prompt}
          prompt={prompt}
          send
          asChild
          onClick={(event) => void action.send(event, prompt)}
        >
          <Button
            variant="outline"
            size="sm"
            className="h-auto max-w-full rounded-full px-3 py-2 text-xs whitespace-normal text-left shadow-none"
          >
            {prompt}
          </Button>
        </ThreadPrimitive.Suggestion>
      ))}
    </div>
  );
}

export const ui = {
  assistantActions: Regenerate,
  assistantFooter: FollowupSuggestions,
} satisfies NonNullable<BrowserExtension['ui']>;
