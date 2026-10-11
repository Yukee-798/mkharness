import {
  ROOT_CONVERSATION_ID,
  type AgentEvent,
  type Harness,
  type EntryRecord,
  type Cursor,
} from '@earendil-works/pi-durable';
import { BG } from './conversation';
import { AppError } from '../shared/contracts';
import { ToolProgressFold } from '../shared/tool-progress';
import type { ServerContribution } from './contributions';

export async function restoreToolProgress(
  pi: Harness,
  snapshot: Extract<AgentEvent, { type: 'snapshot' }>,
  entries: readonly EntryRecord[] = snapshot.entries,
) {
  const fold = new ToolProgressFold();
  // Context compaction trims the watch view, but browser progress covers the full history.
  // Read history before opening the watch, then overlay its newer atomic snapshot.
  const history = new Map(entries.map((entry) => [Number(entry.id), entry]));
  for (const entry of snapshot.entries) history.set(Number(entry.id), entry);
  let assistant: number | undefined;
  for (const slot of snapshot.tools)
    if (slot.taskId !== undefined) {
      const task = await pi.getTask(slot.taskId, BG);
      const input = task?.input as { assistant?: number; callId?: string } | undefined;
      if (
        task?.kind !== 'pi.tool' ||
        input?.callId !== slot.callId ||
        !input.assistant ||
        (assistant !== undefined && assistant !== input.assistant)
      )
        throw new AppError(409, 'tool_progress_identity');
      assistant = input.assistant;
    }
  if (snapshot.tools.length && assistant === undefined) {
    const generations = (await pi.inspect(BG)).tasks.filter(
      (task) => task.record.kind === 'pi.generation',
    );
    for (const task of generations) {
      const checkpoint = task.record.state.checkpoint as
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
  let cursor: Cursor | undefined;
  do {
    const tasks = await pi.commit(
      (tx) =>
        tx.scanTasks(
          {
            conversationId: ROOT_CONVERSATION_ID,
            kind: 'pi.tool',
            status: 'terminal',
            order: 'descending',
          },
          100,
          cursor,
        ),
      BG,
    );
    for (const task of tasks.items)
      if (task.state.status === 'terminal' && task.state.outcome.status !== 'completed') {
        const input = task.input as { assistant?: number; callId?: string };
        if (input.assistant && typeof input.callId === 'string')
          fold.end(`${input.assistant}.${encodeURIComponent(input.callId)}`, false);
      }
    cursor = tasks.next;
  } while (cursor);
  return fold;
}
export function toolProjector(contributions: readonly ServerContribution[]) {
  return (name: string) =>
    contributions.find((contribution) =>
      contribution.extension?.tools?.some((tool) => tool.name === name),
    )?.projectTool;
}
