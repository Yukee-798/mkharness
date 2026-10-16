import { MessageImages } from '../image-attachments';
import { useLocale } from '../../app/locale';
import {
  useExtensionContext,
  ExtensionContext,
  canonicalMessageId,
} from '../../extensions/extension-context';
import { useMemo, type ReactNode } from 'react';
import {
  useAuiState,
  MessagePrimitive,
  groupPartByType,
  type ToolCallMessagePartProps,
  type TextMessagePartProps,
} from '@assistant-ui/react';
import { MarkdownText } from './markdown-text';
import { Reasoning, ReasoningRoot, ReasoningContent, ReasoningText } from './reasoning.aui';
import { ToolActivity } from './tool-activity';
import { AssistantFooter } from './assistant-footer';
import { ToolGroupRoot, ToolGroupContent } from './tool-group';
import { DisclosureTrigger, disclosureContentClass, TraceLine } from './trace';
import { Wrench, Brain } from 'lucide-react';
function Tool(part: ToolCallMessagePartProps) {
  return <ToolActivity part={part} />;
}
function AssistantText(part: TextMessagePartProps) {
  const { t } = useLocale();
  if (part.text === '' && part.status.type === 'running')
    return <TraceLine live label={t('正在思考…')} icon={<Brain />} />;
  return <MarkdownText />;
}
// GroupedParts is for adjacent runs; the native clustering primitive is retained
// specifically for non-adjacent parts. Tool calls still use GroupedParts below.
const groupReasoningParts = (parts: readonly { type: string }[]) => {
  const indices = parts.flatMap((part, index) => (part.type === 'reasoning' ? [index] : []));
  return indices.length ? [{ groupKey: 'reasoning', indices }] : [];
};
function AssistantReasoning({ children }: { children?: ReactNode }) {
  const { t } = useLocale();
  const { activity } = useExtensionContext();
  const parts = useAuiState((s) => s.message.parts);
  const running = parts.some((part) => part.type === 'reasoning' && part.status.type === 'running');
  const hasTools = parts.some(
    (part) => part.type === 'tool-call' && activity[part.toolName] !== 'hidden',
  );
  return (
    <ReasoningRoot variant="ghost" streaming={running && !hasTools} className="mb-0">
      <DisclosureTrigger
        icon={<Brain />}
        live={running}
        label={running ? t('正在思考…') : t('思考过程')}
      />
      <ReasoningContent aria-busy={running} className={disclosureContentClass}>
        <ReasoningText className="ps-0">{children}</ReasoningText>
      </ReasoningContent>
    </ReasoningRoot>
  );
}
const reasoningComponents = { Group: AssistantReasoning, Reasoning };
export function Assistant() {
  const context = useExtensionContext();
  const id = useAuiState((s) => s.message.id);
  const canonical = canonicalMessageId(id, context.messageIds).split(':')[0]!;
  const annotation = context.annotations?.[canonical];
  return (
    <ExtensionContext
      value={annotation ? { ...context, state: { ...context.state, ...annotation } } : context}
    >
      <AssistantContents />
    </ExtensionContext>
  );
}
function AssistantContents() {
  const { t } = useLocale();
  const messageId = useAuiState((s) => s.message.id);
  const content = useAuiState((s) => s.message.content);
  const { activity, toolkit } = useExtensionContext();
  const groupAssistantParts = useMemo(
    () =>
      groupPartByType({
        reasoning: ['group-reasoning'],
        'tool-call': ['group-tool'],
        'standalone-tool-call': [],
        ...Object.fromEntries(
          Object.entries(activity)
            .filter(([, visibility]) => visibility === 'hidden')
            .map(([name]) => [`tool-call:${name}`, []]),
        ),
      }),
    [activity],
  );
  const visible = content.filter(
    (part) => part.type !== 'tool-call' || activity[part.toolName] !== 'hidden',
  );
  const traceTail =
    visible.length > 0 &&
    visible.every(
      (part) =>
        part.type === 'reasoning' ||
        (part.type === 'tool-call' && toolkit[part.toolName]?.display !== 'standalone'),
    );
  return (
    <MessagePrimitive.Root
      data-slot="assistant-message"
      data-message-id={messageId}
      data-trace-tail={traceTail}
      className="group/message mb-6 flex min-w-0 flex-col gap-2 text-sm leading-relaxed wrap-anywhere empty:hidden data-[trace-tail=true]:mb-2 has-[+[data-slot=assistant-message]]:mb-2"
    >
      {/* Non-adjacent reasoning belongs to one stable disclosure per model round.
          GroupedParts intentionally only coalesces adjacent parts, so use the SDK's
          supported clustering primitive here rather than rebuilding a message runtime. */}
      {content.some((part) => part.type === 'reasoning') && (
        <MessagePrimitive.Unstable_PartsGrouped
          groupingFunction={groupReasoningParts}
          components={reasoningComponents}
        />
      )}
      {/* Tool scopes and registered standalone content retain their native identities. */}
      {(['tools', 'content'] as const).map((section) => (
        <MessagePrimitive.GroupedParts
          key={section}
          groupBy={groupAssistantParts}
          indicator={section === 'tools' ? 'empty' : 'never'}
        >
          {({ part, children }) => {
            const target =
              part.type === 'group-reasoning' ||
              part.type === 'reasoning' ||
              part.type === 'indicator'
                ? 'tools'
                : part.type === 'group-tool' ||
                    (part.type === 'tool-call' && toolkit[part.toolName]?.display !== 'standalone')
                  ? 'tools'
                  : 'content';
            if (part.type === 'tool-call' && activity[part.toolName] === 'hidden') return <></>;
            // An empty fragment suppresses the native registered-UI fallback too.
            if (target !== section) return <></>;
            switch (part.type) {
              case 'group-tool':
                // Keep the same ancestry from the first call onward. Switching a lone
                // call's fragment to a disclosure remounts its renderer, loses user
                // state and replays all row entrance animations during streaming.
                return (
                  <ToolGroupRoot variant="ghost" defaultOpen>
                    {part.indices.length > 1 && (
                      <DisclosureTrigger
                        icon={<Wrench />}
                        live={part.status.type === 'running'}
                        label={part.status.type === 'running' ? t('正在调用') : t('已调用')}
                        detail={t('{count} 个工具', { count: part.indices.length })}
                        data-slot="tool-group-trigger"
                      />
                    )}
                    <ToolGroupContent
                      className={`${part.indices.length > 1 ? disclosureContentClass : '[&>div]:mt-0!'} [&>div]:gap-2!`}
                    >
                      {children}
                    </ToolGroupContent>
                  </ToolGroupRoot>
                );
              case 'group-reasoning':
              case 'reasoning':
                return <></>;
              case 'text':
                return <AssistantText {...part} />;
              case 'tool-call':
                return (
                  <MessagePrimitive.PartByIndex
                    index={content.findIndex(
                      (item) => item.type === 'tool-call' && item.toolCallId === part.toolCallId,
                    )}
                    components={{ tools: { Fallback: Tool } }}
                  />
                );
              case 'indicator':
                return <TraceLine live label={t('正在思考…')} icon={<Brain />} />;
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
      ))}
      {!traceTail && <AssistantFooter />}
    </MessagePrimitive.Root>
  );
}
export function User() {
  const messageId = useAuiState((s) => s.message.id);
  return (
    <MessagePrimitive.Root
      data-message-id={messageId}
      className="mb-8 ml-auto w-fit max-w-[85%] rounded-2xl bg-muted px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap wrap-anywhere"
    >
      <MessageImages />
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  );
}
