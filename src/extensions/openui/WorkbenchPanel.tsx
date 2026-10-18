import { z } from 'zod';
import { defineWorkbenchPanel } from '../../browser/workbench/panels';
import { useLocale } from '../../browser/app/locale';
import { Panel } from './Panel';

const targetSchema = z
  .object({
    key: z.string().min(1).max(1024),
    ref: z.string().min(1).max(1024).optional(),
    preview: z
      .string()
      .max(3 * 1048576)
      .optional(),
    failure: z.string().max(8192).optional(),
  })
  .strict();
export const previewPanel = defineWorkbenchPanel({
  scope: 'conversation',
  parse: (value) => targetSchema.parse(value),
  key: (target) => target.key,
  title: () => 'Interactive answer',
  restore: (target) => (target.ref ? { key: target.ref, ref: target.ref } : null),
  Content: function OpenUIWorkbenchPanel({ target, conversation }) {
    const { t } = useLocale();
    if (!conversation) return null;
    if (target.failure) return <p role="alert">{t(target.failure)}</p>;
    return (
      <Panel
        conversationId={conversation.chatId}
        userId={conversation.userId}
        panelRef={target.ref}
        preview={target.preview}
        submit={conversation.submit}
      />
    );
  },
});
