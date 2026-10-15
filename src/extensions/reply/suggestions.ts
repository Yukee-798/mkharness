import { z } from 'zod';
import type { ProjectionContext } from '../../server/contributions';

export const SUGGESTIONS_TOOL = 'set_reply_suggestions';
export const suggestionsSchema = z
  .object({
    prompts: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(160)
          .regex(/^[^\p{Cc}]*$/u),
      )
      .max(3),
  })
  .strict()
  .transform(({ prompts }) => ({ prompts: [...new Set(prompts)] }));
export type SuggestionsState = { replies: Record<string, string[]> };

/** Only the exact completed answer's successful metadata call is public. */
export function projectSuggestions({
  entries,
  tasks,
  submissions,
}: ProjectionContext): SuggestionsState {
  const history = new Map(entries.map((entry) => [Number(entry.id), entry]));
  const receipts = new Map(tasks.map((task) => [Number(task.id), task]));
  const metadata = new Map<string, string[] | null>();
  const key = (assistant: number, callId: string) => JSON.stringify([assistant, callId]);
  for (const entry of entries) {
    const task = entry.byTaskId === undefined ? undefined : receipts.get(Number(entry.byTaskId));
    const input = task?.input;
    if (
      task?.kind !== 'pi.tool' ||
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      input.kind !== 'model' ||
      typeof input.assistant !== 'number' ||
      typeof input.callId !== 'string' ||
      Number(entry.id) <= input.assistant
    )
      continue;
    for (const message of entry.model ?? []) {
      if (
        message.role !== 'toolResult' ||
        message.toolName !== SUGGESTIONS_TOOL ||
        message.toolCallId !== input.callId ||
        message.isError
      )
        continue;
      const identity = key(input.assistant, input.callId);
      if (metadata.has(identity)) {
        metadata.set(identity, null);
        continue;
      }
      try {
        const parsed = suggestionsSchema.safeParse(
          JSON.parse(
            message.content
              .filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join(''),
          ),
        );
        metadata.set(identity, parsed.success ? parsed.data.prompts : null);
      } catch {
        metadata.set(identity, null);
      }
    }
  }
  const replies: SuggestionsState['replies'] = {};
  for (const submission of submissions) {
    if (submission.type !== 'input' || submission.status !== 'done') continue;
    const answer = history.get(Number(submission.answer));
    if (!answer || Number(submission.answer) <= Number(submission.entry)) continue;
    const calls = (answer.model ?? []).flatMap((message) =>
      message.role === 'assistant'
        ? message.content.filter(
            (part) => part.type === 'toolCall' && part.name === SUGGESTIONS_TOOL,
          )
        : [],
    );
    // Ambiguous calls or duplicate results cannot supersede one another.
    if (calls.length !== 1 || calls[0]!.type !== 'toolCall') continue;
    const prompts = metadata.get(key(Number(answer.id), calls[0]!.id));
    if (prompts?.length) replies[String(answer.id)] = prompts;
  }
  return { replies };
}
