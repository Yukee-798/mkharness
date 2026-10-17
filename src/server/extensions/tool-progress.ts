import {
  type ConversationId,
  type AgentEvent,
  type Harness,
  type EntryRecord,
  type TaskRecord,
} from '@earendil-works/pi-durable';
import type { Json } from '../../shared/json';
import { BG } from '../chat/context';
import { AppError } from '../../shared/contracts';
import { ToolProgressFold } from '../../shared/tool-progress';
import type { ServerContribution } from './contributions';

export function restoreHistoryToolProgress(
  entries: readonly EntryRecord[],
  tasks: readonly TaskRecord<Json, Json, Json>[],
) {
  const fold = new ToolProgressFold();
  if (!fold.restore(entries, [])) throw new AppError(409, 'tool_progress_identity');
  for (const task of tasks)
    if (
      task.kind === 'pi.tool' &&
      task.state.status === 'terminal' &&
      task.state.outcome.status !== 'completed'
    ) {
      const input = task.input as { kind?: string; assistant?: number; callId?: string };
      if (input.kind === 'model' && input.assistant && typeof input.callId === 'string')
        fold.end(`${input.assistant}.${encodeURIComponent(input.callId)}`, false);
    }
  return fold;
}

export async function restoreToolProgress(
  pi: Harness,
  target: ConversationId,
  snapshot: Extract<AgentEvent, { type: 'snapshot' }>,
  entries: readonly EntryRecord[],
  restoredTasks: readonly TaskRecord<Json, Json, Json>[],
) {
  const fold = new ToolProgressFold();
  // Overlay the native watch only within the loaded page's lower boundary.
  const history = new Map(entries.map((entry) => [Number(entry.id), entry]));
  const lower = Number(entries[0]?.id ?? 0);
  for (const entry of snapshot.entries)
    if (Number(entry.id) >= lower) history.set(Number(entry.id), entry);
  let assistant: number | undefined;
  for (const slot of snapshot.tools)
    if (slot.taskId !== undefined) {
      const task =
        restoredTasks.find((task) => task.id === slot.taskId) ??
        (await pi.getTask(slot.taskId, BG));
      const input = task?.input as
        { kind?: string; assistant?: number; callId?: string } | undefined;
      if (
        task?.conversationId !== target ||
        task.kind !== 'pi.tool' ||
        input?.kind !== 'model' ||
        input.callId !== slot.callId ||
        !input.assistant ||
        (assistant !== undefined && assistant !== input.assistant)
      )
        throw new AppError(409, 'tool_progress_identity');
      assistant = input.assistant;
    }
  if (snapshot.tools.length && assistant === undefined) {
    const generations = restoredTasks;
    for (const task of generations) {
      if (task.conversationId !== target || task.kind !== 'pi.generation') continue;
      const checkpoint = task.state.checkpoint as
        { phase?: string; assistant?: number } | undefined;
      if (checkpoint?.phase === 'tools') assistant = checkpoint.assistant;
    }
  }
  if (
    !fold.restore(
      [...history.values()].sort((a, b) => Number(a.id) - Number(b.id)),
      snapshot.tools,
      assistant,
    )
  )
    throw new AppError(409, 'tool_progress_identity');
  // Pi receipts provide failures with no result entry. They remain authoritative after live slots clear.
  const failures = (tasks: readonly TaskRecord<Json, Json, Json>[]) => {
    for (const task of tasks)
      if (
        task.kind === 'pi.tool' &&
        task.state.status === 'terminal' &&
        task.state.outcome.status !== 'completed'
      ) {
        const input = task.input as { kind?: string; assistant?: number; callId?: string };
        if (input.kind === 'model' && input.assistant && typeof input.callId === 'string')
          fold.end(`${input.assistant}.${encodeURIComponent(input.callId)}`, false);
      }
  };
  failures(restoredTasks);
  return fold;
}
export function toolProjector(contributions: readonly ServerContribution[]) {
  return (name: string) =>
    contributions.find((contribution) =>
      contribution.extension?.tools?.some((tool) => tool.name === name),
    )?.projectTool;
}
