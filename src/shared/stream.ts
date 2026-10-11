import type { AgentEvent, EntryRecord } from '@earendil-works/pi-durable';
import type { AssistantMessage, Message as PiMessage } from '@earendil-works/pi-ai';
import { EventType, type BaseEvent, type Message, type ToolCallResultEvent } from '@ag-ui/core';
import { toolRef } from './references';
import { USER_ACTION_CONTEXT } from './contracts';
/** Pi changes are replacements or path appends, not raw JSON token deltas. */
export class StreamFold {
  current?: AssistantMessage;
  accept(event: AgentEvent) {
    if (event.type === 'snapshot')
      this.current = event.generation?.message
        ? structuredClone(event.generation.message)
        : undefined;
    else if (event.type === 'message_start')
      this.current =
        event.message.role === 'assistant' ? structuredClone(event.message) : undefined;
    else if (event.type === 'message_update')
      for (const change of event.changes) {
        if (change.type === 'message') {
          this.current = structuredClone(change.message);
          continue;
        }
        if (!this.current) throw new Error('Pi changed a missing draft');
        if ('block' in change) {
          this.current.content[change.contentIndex] = structuredClone(change.block);
          continue;
        }
        const block = this.current.content[change.contentIndex];
        if (change.type === 'text_delta' && block?.type === 'text') block.text += change.delta;
        else if (change.type === 'thinking_delta' && block?.type === 'thinking')
          block.thinking += change.delta;
        else if (change.type === 'toolcall_delta' && block?.type === 'toolCall') {
          let target: Record<string, unknown> = block.arguments;
          for (const part of change.path.slice(0, -1)) {
            if (!Object.hasOwn(target, part)) throw new Error('Invalid Pi argument path');
            target = target[part] as Record<string, unknown>;
          }
          const key = change.path.at(-1);
          if (key === undefined || !Object.hasOwn(target, key) || typeof target[key] !== 'string')
            throw new Error('Invalid Pi argument append');
          target[key] += change.delta;
        } else throw new Error('Invalid Pi draft change');
      }
  }
}
/** Projects one cumulative Pi draft into AG-UI while keeping its stream identities stable. */
export class DraftProjection {
  private textPrefix: string | undefined;
  private args = new Map<number, string>();
  private reasoning = new Map<number, { prefix: string; ended: boolean }>();
  constructor(
    readonly messageId: string,
    private emit: (event: BaseEvent) => void,
  ) {}
  private startReasoning(index: number) {
    this.emit({
      type: EventType.REASONING_MESSAGE_START,
      messageId: `${this.messageId}:reasoning:${index}`,
      role: 'reasoning',
    } as BaseEvent);
    const previous = this.reasoning.get(index);
    if (previous) previous.ended = false;
    else this.reasoning.set(index, { prefix: '', ended: false });
  }
  /** False means a real non-prefix replacement requires a fresh observation. */
  publish(message: AssistantMessage, complete = false): boolean {
    // The SDK reserves a text part on START and anchors tools after that part. Open
    // initial reasoning first, then establish the round before its first content delta.
    // This also carries reasoning into the new round instead of attaching it to the old one.
    if (this.textPrefix === undefined) {
      const firstIndex = message.content.findIndex(
        (block) =>
          (block.type === 'thinking' && !block.redacted && block.thinking.trim()) ||
          (block.type === 'text' && block.text.length > 0) ||
          block.type === 'toolCall',
      );
      if (firstIndex === -1 && !complete) return true;
      if (message.content[firstIndex]?.type === 'thinking') this.startReasoning(firstIndex);
      this.emit({
        type: EventType.TEXT_MESSAGE_START,
        messageId: this.messageId,
        role: 'assistant',
      } as BaseEvent);
      this.textPrefix = '';
    }
    // Reasoning is model-provided text, not a synthesized status message. Opaque/redacted
    // blocks and provider signatures stay in Pi history and never enter the browser stream.
    for (const [index, previous] of this.reasoning) {
      const block = message.content[index];
      if (
        block?.type !== 'thinking' ||
        block.redacted ||
        !block.thinking.startsWith(previous.prefix)
      ) {
        return false;
      }
    }
    for (const [index, block] of message.content.entries()) {
      if (block.type !== 'thinking' || block.redacted || !block.thinking.trim()) continue;
      const messageId = `${this.messageId}:reasoning:${index}`;
      let previous = this.reasoning.get(index);
      if (!previous) {
        this.startReasoning(index);
        previous = this.reasoning.get(index)!;
      }
      const delta = block.thinking.slice(previous.prefix.length);
      if (delta) {
        // Providers can interleave reasoning with text/args. Reopen the same logical
        // block for a genuine append; only an incompatible prefix requires restoration.
        if (previous.ended) this.startReasoning(index);
        this.emit({ type: EventType.REASONING_MESSAGE_CONTENT, messageId, delta } as BaseEvent);
      }
      previous.prefix = block.thinking;
      // Pi observers expose cumulative partials, not native thinking_end. A following
      // block is a presentation boundary, not proof that the provider cannot append again.
      if (!previous.ended && (complete || index < message.content.length - 1)) {
        this.emit({ type: EventType.REASONING_MESSAGE_END, messageId } as BaseEvent);
        previous.ended = true;
      }
    }
    const blocks = message.content.filter((b) => b.type === 'text');
    if (blocks.length) {
      const next = blocks.map((b) => b.text).join('\n');
      if (!next.startsWith(this.textPrefix)) {
        return false;
      }
      const delta = next.slice(this.textPrefix.length);
      if (delta)
        this.emit({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: this.messageId,
          delta,
        } as BaseEvent);
      this.textPrefix = next;
    }
    for (const [index, block] of message.content.entries()) {
      if (block.type === 'toolCall') {
        const callId = `${this.messageId}.${encodeURIComponent(block.id)}`;
        if (!this.args.has(index)) {
          this.emit({
            type: EventType.TOOL_CALL_START,
            toolCallId: callId,
            toolCallName: block.name,
            parentMessageId: this.messageId,
          } as BaseEvent);
          this.args.set(index, '');
        }
        const next = complete ? JSON.stringify(block.arguments) : openArgs(block.arguments),
          old = this.args.get(index)!;
        if (!next.startsWith(old)) {
          return false;
        }
        const delta = next.slice(old.length);
        if (delta)
          this.emit({ type: EventType.TOOL_CALL_ARGS, toolCallId: callId, delta } as BaseEvent);
        this.args.set(index, next);
        if (complete) this.emit({ type: EventType.TOOL_CALL_END, toolCallId: callId } as BaseEvent);
      }
    }
    if (complete && this.textPrefix !== undefined)
      this.emit({
        type: EventType.TEXT_MESSAGE_END,
        messageId: this.messageId,
      } as BaseEvent);
    return true;
  }
}
/** Keep the last string/container open so later argument appends remain prefixes. */
export function openArgs(args: unknown): string {
  const text = JSON.stringify(args);
  let end = text.length;
  while (end > 0 && (text[end - 1] === '}' || text[end - 1] === ']')) end--;
  if (text[end - 1] === '"') end--;
  return text.slice(0, end);
}
function text(message: PiMessage) {
  const value = message.content;
  return typeof value === 'string'
    ? value
    : value
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
}
/** A browser projection only: provider replay metadata stays in authoritative Pi storage. */
function browserMessage(message: PiMessage): PiMessage {
  if (message.role === 'toolResult') {
    return {
      role: message.role,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: message.content,
      isError: message.isError,
      timestamp: message.timestamp,
    };
  }
  return message.role !== 'assistant'
    ? message
    : {
        ...message,
        content: message.content.map((block) =>
          block.type === 'thinking'
            ? {
                type: 'thinking' as const,
                thinking: block.redacted ? '' : block.thinking,
                ...(block.redacted ? { redacted: true } : {}),
              }
            : block.type === 'text'
              ? { type: 'text' as const, text: block.text }
              : block,
        ),
      };
}
export function browserEntries(entries: readonly EntryRecord[]): EntryRecord[] {
  return entries.map(({ data: _data, ...entry }) => ({
    ...entry,
    model: entry.model?.map(browserMessage),
    edits: entry.edits?.map((edit) =>
      edit.action === 'replace' ? { ...edit, messages: edit.messages.map(browserMessage) } : edit,
    ),
  }));
}
/** Derive exact reasoning and tool references from each aliased assistant record. */
export function messageAliases(
  messages: readonly Message[],
  aliases: ReadonlyMap<string, string>,
): Map<string, string> {
  const references = new Map(aliases);
  for (const message of messages) {
    if (message.role === 'reasoning') {
      const boundary = message.id.lastIndexOf(':reasoning:');
      const liveId = boundary < 0 ? undefined : aliases.get(message.id.slice(0, boundary));
      if (liveId) references.set(message.id, liveId + message.id.slice(boundary));
    }
    const liveId = aliases.get(message.id);
    if (message.role === 'assistant' && liveId)
      for (const call of message.toolCalls ?? [])
        references.set(call.id, liveId + call.id.slice(call.id.indexOf('.')));
  }
  return references;
}
/** Apply one runtime's commit aliases to messages and every reference to their tools. */
export function aliasMessages(
  messages: readonly Message[],
  aliases: ReadonlyMap<string, string>,
): Message[] {
  const references = messageAliases(messages, aliases);
  return messages.map((message) => ({
    ...message,
    id: references.get(message.id) ?? message.id,
    ...(message.role === 'assistant' && message.toolCalls
      ? {
          toolCalls: message.toolCalls.map((call) => ({
            ...call,
            id: references.get(call.id) ?? call.id,
          })),
        }
      : {}),
    ...(message.role === 'tool'
      ? { toolCallId: references.get(message.toolCallId) ?? message.toolCallId }
      : {}),
  }));
}
/** Settle a genuinely committed tool result in the native AG-UI run aggregator. */
export function toolResultEvent(message: Extract<Message, { role: 'tool' }>): ToolCallResultEvent {
  const error = typeof message.error === 'string' ? message.error : undefined;
  return {
    type: EventType.TOOL_CALL_RESULT,
    messageId: message.id,
    toolCallId: message.toolCallId,
    content: message.content,
    role: 'tool',
    // The adapter's MCP result envelope reads isError; a bare tool-role result
    // defaults to success. Preserve the real failure; authoritative Pi stays unchanged.
    ...(error !== undefined ? { structuredContent: { error }, isError: true } : {}),
  };
}
export function toMessages(
  entries: readonly EntryRecord[],
  liveMessageIds: ReadonlyMap<string, string> = new Map(),
): Message[] {
  const result: Message[] = [],
    calls = new Map<string, string>();
  for (const entry of entries)
    for (const [index, message] of (entry.model ?? []).entries()) {
      const id = index ? `${entry.id}:${index}` : String(entry.id);
      if (message.role === 'user')
        result.push({
          id,
          role: 'user',
          content: text(message).split(USER_ACTION_CONTEXT)[0],
        });
      else if (message.role === 'assistant') {
        for (const [blockIndex, block] of message.content.entries())
          if (block.type === 'thinking' && !block.redacted && block.thinking.trim())
            result.push({
              id: `${id}:reasoning:${blockIndex}`,
              role: 'reasoning',
              content: block.thinking,
            });
        const toolCalls = message.content
          .filter((b) => b.type === 'toolCall')
          .map((b) => {
            const callId = toolRef(Number(entry.id), b.id);
            calls.set(b.id, callId);
            return {
              id: callId,
              type: 'function' as const,
              function: { name: b.name, arguments: JSON.stringify(b.arguments) },
            };
          });
        result.push({
          id,
          role: 'assistant',
          content:
            message.stopReason === 'error'
              ? (message.errorMessage ?? text(message))
              : text(message),
          ...(toolCalls.length ? { toolCalls } : {}),
        });
      } else if (message.role === 'toolResult') {
        const callId = calls.get(message.toolCallId);
        if (callId)
          result.push({
            id,
            role: 'tool',
            toolCallId: callId,
            content: text(message),
            ...(message.isError ? { error: text(message) } : {}),
          });
      }
    }
  return aliasMessages(result, liveMessageIds);
}
