import { useAuiState, type ToolCallMessagePartProps } from '@assistant-ui/react';
import { useExtensionContext } from '../../browser/extension-context';
import type { BrowserExtension } from '../../browser/extensions';
import { formatDuration, type TimingState } from './contracts';

function canonicalMessage(id: string, aliases?: ReadonlyMap<string, string>) {
  for (const [canonical, live] of aliases ?? []) if (live === id) return canonical;
  return id;
}
function ToolDuration({ part }: { part: ToolCallMessagePartProps }) {
  const { state, messageIds } = useExtensionContext();
  const boundary = part.toolCallId.indexOf('.');
  const id =
    canonicalMessage(part.toolCallId.slice(0, boundary), messageIds) +
    part.toolCallId.slice(boundary);
  const span = (state?.timing as TimingState | undefined)?.tools?.[id];
  if (span?.endedAt === undefined) return null;
  return (
    <span
      data-slot="tool-duration"
      className="shrink-0 text-xs font-normal text-muted-foreground/65 tabular-nums"
      title="工具执行耗时（包含等待）"
    >
      {formatDuration(Math.max(0, span.endedAt - span.startedAt))}
    </span>
  );
}
function ReplyTiming() {
  const messageId = useAuiState((s) => s.message.id);
  const { state, messageIds } = useExtensionContext();
  const span = (state?.timing as TimingState | undefined)?.replies?.[
    canonicalMessage(messageId, messageIds)
  ];
  if (span?.endedAt === undefined) return null;
  return (
    <p
      data-slot="reply-duration"
      className="flex flex-wrap gap-x-2 gap-y-1 text-[11px] font-normal text-muted-foreground/70 tabular-nums"
    >
      <span title="从开始处理到回复完成，包含工具执行和等待">
        回复耗时 {formatDuration(span.endedAt - span.startedAt)}
      </span>
    </p>
  );
}
export const ui = {
  toolTitleMeta: ToolDuration,
  assistantFooter: ReplyTiming,
} satisfies NonNullable<BrowserExtension['ui']>;
