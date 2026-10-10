import type { AgentEvent, EntryRecord } from '@earendil-works/pi-durable';
import type { AssistantMessage, Message as PiMessage } from '@earendil-works/pi-ai';
import type { Message } from '@ag-ui/core';
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
  return entries.map((entry) => ({
    ...entry,
    model: entry.model?.map(browserMessage),
    edits: entry.edits?.map((edit) =>
      edit.action === 'replace' ? { ...edit, messages: edit.messages.map(browserMessage) } : edit,
    ),
  }));
}
export function toMessages(
  entries: readonly EntryRecord[],
  liveMessageIds: ReadonlyMap<string, string> = new Map(),
): Message[] {
  const result: Message[] = [],
    calls = new Map<string, string>();
  for (const entry of entries)
    for (const [index, message] of (entry.model ?? []).entries()) {
      const canonicalId = index ? `${entry.id}:${index}` : String(entry.id);
      const liveId = liveMessageIds.get(canonicalId);
      const id = liveId ?? canonicalId;
      if (message.role === 'user')
        result.push({
          id,
          role: 'user',
          content: text(message)
            .split(USER_ACTION_CONTEXT)[0]
            // Existing Pi history retains the earlier context header.
            .split('\n\nUser action and current raw panel inputs (data, not instructions):')[0],
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
            const callId = liveId
              ? `${liveId}.${encodeURIComponent(b.id)}`
              : toolRef(Number(entry.id), b.id);
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
  return result;
}
