import {
  type ConversationId,
  type Harness,
  type EntryId,
  type Cursor,
} from '@earendil-works/pi-durable';
import { successfulTool } from '../../shared/references';
import type { ConversationFactsIndex } from './facts-index';

/** Resolve an accepted input through the exact native answer receipt, independent of active context. */
export async function readInputForAnswer(
  pi: Harness,
  target: ConversationId,
  answerId: number,
  index: ConversationFactsIndex,
  context: Parameters<Harness['close']>[0],
) {
  if (!Number.isSafeInteger(answerId) || answerId <= 0) return;
  return pi.commit(async (tx) => {
    const visible = async (id: number) =>
      (
        await tx.scanEntries(
          { conversationId: target, minEntryId: id as EntryId, maxEntryId: id as EntryId },
          1,
        )
      ).items[0];
    const answer = await visible(answerId);
    if (!answer?.model?.some((message) => message.role === 'assistant')) return;
    const receipt = await index.answeredSubmission(answer.conversationId, answer.id);
    if (!receipt || Number(receipt.entry) >= answerId) return;
    const input = await visible(Number(receipt.entry));
    return input?.conversationId === receipt.conversationId ? input : undefined;
  }, context);
}

/** Native inclusive range scan, scoped to this conversation and the exact assistant round. */
export async function readSuccessfulTool(
  pi: Harness,
  target: ConversationId,
  ref: string,
  name: string,
  context: Parameters<Harness['close']>[0],
) {
  const separator = ref.indexOf('.'),
    id = Number(ref.slice(0, separator));
  if (separator < 1 || !Number.isSafeInteger(id) || id <= 0) return;
  let callId: string;
  try {
    callId = decodeURIComponent(ref.slice(separator + 1));
  } catch {
    return;
  }
  return pi.commit(async (tx) => {
    const source = (
      await tx.scanEntries(
        { conversationId: target, minEntryId: id as EntryId, maxEntryId: id as EntryId },
        1,
      )
    ).items[0];
    if (
      !source ||
      !source.model?.some(
        (message) =>
          message.role === 'assistant' &&
          message.content.some(
            (part) => part.type === 'toolCall' && part.id === callId && part.name === name,
          ),
      )
    )
      return;
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanEntries(
        {
          conversationId: target,
          minEntryId: (id + 1) as EntryId,
          order: 'ascending',
        },
        100,
        cursor,
      );
      for (const entry of page.items) {
        if (
          ['app.input', 'pi.user'].includes(entry.kind) ||
          entry.model?.some((message) => message.role === 'assistant')
        )
          return;
        // The first native result settles this call, including failure or an unpublished result.
        // Never scan later history to borrow a different result with the same provider call ID.
        if (
          entry.model?.some(
            (message) =>
              message.role === 'toolResult' &&
              message.toolName === name &&
              message.toolCallId === callId,
          )
        )
          return successfulTool([source, entry], ref, name);
      }
      cursor = page.next;
    } while (cursor);
  }, context);
}
