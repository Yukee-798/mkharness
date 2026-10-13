import {
  ROOT_CONVERSATION_ID,
  type Harness,
  type EntryId,
  type Cursor,
} from '@earendil-works/pi-durable';
import { successfulTool } from '../shared/references';

/** Native inclusive range scan, scoped to this conversation and the exact assistant round. */
export async function readSuccessfulTool(
  pi: Harness,
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
    const source = await tx.entry(id as EntryId);
    if (
      !source ||
      source.conversationId !== ROOT_CONVERSATION_ID ||
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
          conversationId: ROOT_CONVERSATION_ID,
          minEntryId: (id + 1) as EntryId,
          order: 'ascending',
        },
        100,
        cursor,
      );
      for (const entry of page.items) {
        if (entry.model?.some((message) => message.role === 'assistant')) return;
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
