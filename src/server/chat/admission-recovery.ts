import { LiveDoc, type Harness, type ConversationId } from '@earendil-works/pi-durable';

/** A failed run leaves followers paused in Pi's inbox. Withdraw them without replaying side effects. */
export async function withdrawFailedFollowers(
  pi: Harness,
  target: ConversationId,
  context: Parameters<Harness['close']>[0],
) {
  const queued = (await pi.inspect(context)).submissions.filter(
    (item) => item.conversationId === target && item.type === 'input' && item.status === 'queued',
  );
  if (!queued.length || (await pi.snapshot(LiveDoc, target, context))?.run) return;
  for (const input of queued) await pi.abortSubmission(input.id, context, target);
}
