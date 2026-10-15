import type { ServerContribution } from '../../server/contributions';
import { AppError } from '../../shared/contracts';
import { defineTool, type EntryId } from '@earendil-works/pi-durable';
import { Type } from '@earendil-works/pi-ai';
import { projectSuggestions, suggestionsSchema, SUGGESTIONS_TOOL } from './suggestions';

const suggestions = defineTool({
  name: SUGGESTIONS_TOOL,
  callers: ['model'],
  description:
    "Commit up to three specific follow-up messages for this final answer. Each prompt is a concise request the user could send next, in the user's language. Use [] when no useful continuation exists. This local metadata tool ends the reply after a successful commit; include the substantive answer as text in this same response, or call alongside the final display tool. Never call it before research/computation is complete.",
  parameters: Type.Object({
    prompts: Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { maxItems: 3 }),
  }),
  replay: 'safe',
  outputLimits: { maxBytes: 4096 },
  execute: async (args, api, context) => {
    const parsed = suggestionsSchema.safeParse(args);
    if (!parsed.success)
      return { isError: true, output: [{ type: 'text', text: 'Invalid follow-up prompts' }] };
    const valid = await api.commit(async (tx) => {
      const task = await tx.task(api.taskId);
      const input = task?.input;
      if (!input || typeof input !== 'object' || Array.isArray(input) || input.kind !== 'model')
        return false;
      if (typeof input.assistant !== 'number') return false;
      const entry = await tx.entry(input.assistant as EntryId);
      return entry?.model?.some(
        (message) =>
          message.role === 'assistant' &&
          (message.content.some((part) => part.type === 'text' && part.text.trim()) ||
            message.content.some(
              (part) => part.type === 'toolCall' && part.name !== SUGGESTIONS_TOOL,
            )) &&
          message.content.filter(
            (part) => part.type === 'toolCall' && part.name === SUGGESTIONS_TOOL,
          ).length === 1,
      );
    }, context);
    if (!valid)
      return {
        isError: true,
        output: [
          {
            type: 'text',
            text: 'Provide the final answer with one follow-up call after other tools finish.',
          },
        ],
      };
    return {
      output: [{ type: 'text', text: JSON.stringify(parsed.data) }],
      // Native Pi awaits every sibling and only terminates when ALL calls agree.
      // Research, failed presentation and unfinished work retain their normal continuation.
      control: { terminate: true },
    };
  },
});

/** Regeneration is a new ordinary input. It neither rewinds Pi nor authorizes remote replay. */
export const replyContribution = (): ServerContribution => ({
  id: 'reply',
  extension: {
    name: 'reply',
    tools: [suggestions],
    sections: [
      {
        key: 'reply-followups',
        render: () =>
          "When completing a reply, generate up to three useful, distinct next messages from the conversation and the answer you are giving. Make them specific to the current subject and unresolved needs; do not repeat answered questions or generic summary/example/next-step chips. Use the user's language and concise standalone prompts (at most 160 characters each). These are optional suggestions, not permission or authorization for any action. Omit sensitive private data. Use an empty prompts array for a greeting, a closed task, or no useful continuation. Emit set_reply_suggestions exactly once in the SAME final model response as the substantive text answer. When displaying the final answer with present_openui, call set_reply_suggestions alongside present_openui in that same round; this is the sole exception to its call-alone guidance. Both tools commit and finish without another model request. Complete all other tools first. Never make a separate model round only to generate suggestions and never print these metadata prompts in the answer.",
      },
    ],
  },
  projectState: projectSuggestions,
  actions: {
    regenerate: {
      async normalize(payload, context) {
        if (
          !payload ||
          typeof payload !== 'object' ||
          Array.isArray(payload) ||
          typeof payload.entryId !== 'string' ||
          !/^[1-9]\d*$/.test(payload.entryId)
        )
          throw new AppError(400, 'invalid_action_payload');
        const entries = [...(await context.entries())].sort((a, b) => Number(a.id) - Number(b.id));
        const target = entries.findIndex((entry) => String(entry.id) === payload.entryId);
        if (target < 0 || !entries[target]!.model?.some((message) => message.role === 'assistant'))
          throw new AppError(404, 'reply_not_found');
        const user = entries.slice(0, target).findLast((entry) => entry.kind === 'pi.user');
        const input = user ? await context.acceptedInput(Number(user.id)) : undefined;
        if (!input) throw new AppError(404, 'reply_not_found');
        if (
          input.source?.action === 'extension_action' &&
          input.source.extensionId === 'reply' &&
          input.source.name === 'regenerate'
        ) {
          const original = input.context;
          if (
            !original ||
            typeof original !== 'object' ||
            Array.isArray(original) ||
            !original.originalRequest
          )
            throw new AppError(409, 'reply_context_unavailable');
          return { action: 'regenerate', originalRequest: original.originalRequest };
        }
        return {
          action: 'regenerate',
          originalRequest: {
            text: input.text,
            ...(input.context !== undefined ? { context: input.context } : {}),
          },
        };
      },
    },
  },
});
