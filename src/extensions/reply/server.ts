import type { ServerContribution } from '../../server/contributions';
import { AppError } from '../../shared/contracts';

/** Regeneration is a new ordinary input. It neither rewinds Pi nor authorizes remote replay. */
export const replyContribution = (): ServerContribution => ({
  id: 'reply',
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
