import type { EntryRecord } from '@earendil-works/pi-durable';
import type { RunCommand } from '../../../shared/contracts';
import type { Snapshot } from './snapshot';

/** The latest submission attempt for this chat, as the submission mutation reports it. */
export type OutgoingAttempt = {
  submission?: { command: RunCommand; initial: boolean };
  status: 'idle' | 'pending' | 'success' | 'error';
};

/** Where the latest follow-up was sent from: the last committed entry, and whether the chat
 * was idle. Recorded when the composer submits, before the request's run ID is frozen. */
export type OutgoingBaseline = { lastEntry: number; idle: boolean };

export const lastEntryId = (entries: readonly EntryRecord[]) =>
  entries.reduce((max, entry) => Math.max(max, Number(entry.id) || 0), 0);

const placedUser = (snapshot: Snapshot, after: number) =>
  snapshot.entries.some(
    (entry) => Number(entry.id) > after && entry.model?.some((message) => message.role === 'user'),
  );

/**
 * The user message to render before Pi commits it, or undefined.
 *
 * Identity is the client-frozen run ID plus the entry boundary at submission, never text.
 * - The first message of a just-created chat shows until Pi exposes a user entry or accepted work.
 * - A follow-up sent from an idle chat shows while its request is in flight and after admission,
 *   until Pi commits a user entry past the baseline, or until the chat no longer lists the run
 *   once acknowledgement settles (withdrawn or failed admission).
 * - A follow-up sent while work is pending is a queued input; the queue owns its display.
 * - A failed submission is never shown here; the composer restores its draft.
 */
export function outgoingMessage(
  snapshot: Snapshot,
  attempt: OutgoingAttempt | undefined,
  baseline: OutgoingBaseline | undefined,
  acknowledging: boolean,
): RunCommand | undefined {
  const submission = attempt?.submission;
  if (!submission) return undefined;
  if (submission.initial)
    return !snapshot.pending.length && !placedUser(snapshot, 0) ? submission.command : undefined;
  const runId = submission.command.runId;
  if (attempt.status === 'error' || attempt.status === 'idle') return undefined;
  if (!baseline?.idle) return undefined;
  if (placedUser(snapshot, baseline.lastEntry)) return undefined;
  if (
    attempt.status === 'success' &&
    !acknowledging &&
    !snapshot.pending.some((item) => item.operationId === runId)
  )
    return undefined;
  return submission.command;
}
