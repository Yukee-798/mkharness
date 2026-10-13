import type { ProjectionContext, ServerContribution } from '../../server/contributions';
import type { TimingState } from './contracts';
import { toolRef } from '../../shared/references';

export function projectTiming({ entries, tasks, submissions }: ProjectionContext): TimingState {
  const history = new Map(entries.map((entry) => [Number(entry.id), entry]));
  const receipts = new Map(tasks.map((task) => [Number(task.id), task]));
  const tools: TimingState['tools'] = {};
  const replies: TimingState['replies'] = {};
  for (const task of tasks) {
    if (task.kind !== 'pi.tool' || !Number.isFinite(task.startedAt)) continue;
    const input = task.input as { assistant?: number; callId?: string };
    const entry = history.get(input.assistant ?? -1);
    // Use native task/entry identity, not tool name, arguments or timestamps to match calls.
    if (
      !entry?.model?.some(
        (message) =>
          message.role === 'assistant' &&
          message.content.some((part) => part.type === 'toolCall' && part.id === input.callId),
      ) ||
      typeof input.callId !== 'string'
    )
      continue;
    tools[toolRef(Number(entry.id), input.callId)] = {
      startedAt: task.startedAt!,
      ...(task.state.status === 'terminal' && Number.isFinite(task.endedAt)
        ? { endedAt: task.endedAt }
        : {}),
    };
  }
  for (const submission of submissions) {
    if (submission.type !== 'input' || submission.status !== 'done' || !submission.requestId)
      continue;
    const user = history.get(Number(submission.entry));
    const answer = history.get(Number(submission.answer));
    const task = answer?.byTaskId === undefined ? undefined : receipts.get(Number(answer.byTaskId));
    const startedAt = user?.model?.find((message) => message.role === 'user')?.timestamp;
    // Pi stamps input placement when execution takes ownership, excluding time in the queue.
    // The final generation spans its tool round too (including terminate-only UI replies).
    if (
      !Number.isFinite(startedAt) ||
      task?.kind !== 'pi.generation' ||
      task.state.status !== 'terminal' ||
      !Number.isFinite(task.endedAt) ||
      task.endedAt! < startedAt!
    )
      continue;
    const id = String(submission.answer);
    const previous = replies[id];
    if (!previous || previous.startedAt > startedAt!)
      replies[id] = { runId: submission.requestId, startedAt: startedAt!, endedAt: task.endedAt };
  }
  return { tools, replies };
}

/** Observability-only extension: no model tools, prompt injection or extra persisted results. */
export const timingContribution = (): ServerContribution => ({
  id: 'timing',
  projectState: projectTiming,
});
