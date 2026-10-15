import { z } from 'zod';
import type { RunCommand } from './contracts';
import type { ImageAttachment } from './images';

export const queueActionSchema = z.object({ action: z.enum(['edit', 'steer', 'remove']) }).strict();
export type QueueAction = z.infer<typeof queueActionSchema>['action'];
/** Public projection of Pi's inbox. No execution or credential metadata. */
export type QueuedInput = {
  runId: string;
  text: string;
  images?: (Omit<ImageAttachment, 'data'> & { data?: string })[];
  mode: 'followUp' | 'steer';
};
export type QueueDraft = Omit<RunCommand, 'runId'>;
export type QueueActionResult = { queue: QueuedInput[]; draft?: QueueDraft };
