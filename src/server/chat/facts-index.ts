import type {
  Storage,
  EntryRecord,
  EntryId,
  TaskId,
  SubmissionId,
  ConversationId,
} from '@earendil-works/pi-durable';
import type { SqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite';
import type { ProjectionContext } from '../extensions/contributions';
import { toolRef } from '../../shared/references';
import { BG } from './context';

type TaskFact = ProjectionContext['tasks'][number];

function inheritedOutput(task: TaskFact, visible: ReadonlyMap<number, EntryRecord>) {
  if (task.state.status !== 'terminal') return;
  const result = task.state.outcome.result;
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    typeof result.entryId !== 'number'
  )
    return;
  const output = visible.get(result.entryId);
  if (output?.byTaskId === task.id && output.conversationId === task.conversationId) return output;
}

function inheritedTool(task: TaskFact, visible: ReadonlyMap<number, EntryRecord>) {
  if (task.kind !== 'pi.tool' || task.state.status !== 'terminal') return;
  const result = task.state.outcome.result;
  if (!result || typeof result !== 'object' || Array.isArray(result) || result.kind !== 'model')
    return;
  const output = inheritedOutput(task, visible);
  if (!output) return;
  const input = task.input;
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    input.kind !== 'model' ||
    typeof input.assistant !== 'number' ||
    typeof input.callId !== 'string'
  )
    return;
  const assistant = visible.get(input.assistant);
  if (assistant?.conversationId !== task.conversationId || assistant.byTaskId !== task.owner)
    return;
  if (
    assistant.model?.some(
      (message) =>
        message.role === 'assistant' &&
        message.content.some(
          (part) =>
            part.type === 'toolCall' &&
            part.id === input.callId &&
            output.model?.some(
              (message) =>
                message.role === 'toolResult' &&
                message.toolCallId === part.id &&
                message.toolName === part.name,
            ),
        ),
    )
  )
    return toolRef(input.assistant, input.callId);
}

/** Locators only. Exact facts always come from public Pi Storage, including fork history. */
export class ConversationFactsIndex {
  constructor(
    private database: SqliteDatabase,
    private native: Storage,
  ) {}
  async revision() {
    return (await this.database.get<{ revision: number }>(
      'SELECT revision FROM app_read_meta WHERE singleton=1',
    ))!.revision;
  }
  async lowerBound(conversationId: ConversationId, min: number, max: number) {
    return (
      (
        await this.database.get<{ entry: number | null }>(
          'SELECT MIN(entry) AS entry FROM app_read_submissions WHERE conversation_id=? AND answer>=? AND answer<=?',
          Number(conversationId),
          min,
          max,
        )
      )?.entry ?? min
    );
  }
  async answeredSubmission(conversationId: ConversationId, answerId: EntryId) {
    const locator = await this.database.get<{ id: number }>(
      'SELECT id FROM app_read_submissions WHERE conversation_id=? AND answer=? AND status=? ORDER BY entry DESC LIMIT 1',
      Number(conversationId),
      Number(answerId),
      'done',
    );
    if (!locator) return;
    const receipt = await this.native.submission(locator.id as SubmissionId, BG);
    if (
      receipt?.conversationId === conversationId &&
      receipt.type === 'input' &&
      receipt.status === 'done' &&
      receipt.answer === answerId
    )
      return receipt;
  }
  async facts(
    conversationId: ConversationId,
    entries: readonly EntryRecord[],
    extraTasks: readonly number[] = [],
  ): Promise<ProjectionContext> {
    const min = Number(entries[0]?.id ?? 0),
      max = Number(entries.at(-1)?.id ?? 0);
    const visible = new Map(entries.map((entry) => [Number(entry.id), entry]));
    const owners = new Set([
      Number(conversationId),
      ...entries.map((e) => Number(e.conversationId)),
    ]);
    const taskIds = new Set(extraTasks);
    for (const entry of entries)
      if (entry.byTaskId !== undefined) taskIds.add(Number(entry.byTaskId));
    const submissionIds = new Set<number>();
    for (const owner of owners) {
      const tasks = await this.database.all<{ id: number }>(
        'SELECT id FROM app_read_tasks WHERE conversation_id=? AND (assistant BETWEEN ? AND ? OR (conversation_id=? AND status IN (?,?,?)))',
        owner,
        min,
        max,
        Number(conversationId),
        'pending',
        'running',
        'waiting',
      );
      tasks.forEach(({ id }) => taskIds.add(id));
      const submissions = await this.database.all<{ id: number }>(
        'SELECT id FROM app_read_submissions WHERE conversation_id=? AND (entry BETWEEN ? AND ? OR answer BETWEEN ? AND ? OR (conversation_id=? AND status IN (?,?)))',
        owner,
        min,
        max,
        min,
        max,
        Number(conversationId),
        'queued',
        'placed',
      );
      submissions.forEach(({ id }) => submissionIds.add(id));
    }
    const candidates = (
      await Promise.all([...taskIds].map((id) => this.native.task(id as TaskId, BG)))
    ).filter((task) => task !== undefined);
    const toolReceipts = new Map<string, TaskFact>();
    for (const task of candidates) {
      const ref = inheritedTool(task, visible);
      if (ref) toolReceipts.set(ref, task);
    }
    const tasks = candidates.filter((task) => {
      if (task.conversationId === conversationId) return true;
      if (!owners.has(Number(task.conversationId))) return false;
      const output = inheritedOutput(task, visible);
      if (!output) return false;
      // A tool receipt needs its own visible native output, never another round's
      // result with the same provider call ID.
      if (task.kind === 'pi.tool') return inheritedTool(task, visible) !== undefined;
      if (
        task.kind !== 'pi.generation' ||
        !output.model?.some((message) => message.role === 'assistant')
      )
        return false;
      // A tool-calling assistant precedes generation completion. Its final duration
      // belongs to the fork only once every exact owned tool result is also visible.
      return output.model.every(
        (message) =>
          message.role !== 'assistant' ||
          message.content.every(
            (part) =>
              part.type !== 'toolCall' ||
              toolReceipts.get(toolRef(Number(output.id), part.id))?.owner === task.id,
          ),
      );
    });
    const submissions = (
      await Promise.all(
        [...submissionIds].map((id) => this.native.submission(id as SubmissionId, BG)),
      )
    )
      .filter(
        (item) =>
          item &&
          (item.conversationId === conversationId ||
            (item.type === 'input' &&
              item.status === 'done' &&
              visible.has(Number(item.entry)) &&
              visible.has(Number(item.answer)))),
      )
      .filter((item) => item !== undefined);
    return { entries, tasks, submissions };
  }
}
