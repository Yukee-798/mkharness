import { LiveDoc, ROOT_CONVERSATION_ID, type Harness } from '@earendil-works/pi-durable';

/** A failed native run pauses its inbox. Withdraw unexecuted inputs rather than replaying them. */
export async function withdrawIdleInputs(pi: Harness, context: Parameters<Harness['close']>[0]) {
  if ((await pi.snapshot(LiveDoc, ROOT_CONVERSATION_ID, context))?.run) return;
  for (const input of (await pi.inspect(context)).submissions)
    if (
      input.conversationId === ROOT_CONVERSATION_ID &&
      input.type === 'input' &&
      input.status === 'queued'
    )
      await pi.abortSubmission(input.id, context, ROOT_CONVERSATION_ID);
}
