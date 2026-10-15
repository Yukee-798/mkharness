import { z } from 'zod';
import type { RunCommand, StoredCommand } from '../../shared/contracts';

export const ASYNC_EXAMPLE_ID = 'async-example';
export const remoteActionPayload = z.object({ taskId: z.number().int().positive() }).strict();
const legacySource = z
  .object({
    action: z.enum(['retry_remote', 'recheck_remote']),
    taskId: z.number().int().positive(),
  })
  .strict();

export function remoteActionSource(
  name: 'retry' | 'recheck',
  taskId: number,
): RunCommand['source'] {
  return { action: 'extension_action', extensionId: ASYNC_EXAMPLE_ID, name, payload: { taskId } };
}

/** Legacy support is limited to already accepted receipts, never public admission. */
export function remoteSource(source: StoredCommand['source']) {
  if (source?.action === 'extension_action' && source.extensionId === ASYNC_EXAMPLE_ID) {
    const payload = remoteActionPayload.safeParse(source.payload);
    if (payload.success && (source.name === 'retry' || source.name === 'recheck'))
      return {
        action: source.name === 'retry' ? 'retry_remote' : 'recheck_remote',
        ...payload.data,
      };
    return;
  }
  const legacy = legacySource.safeParse(source);
  return legacy.success ? legacy.data : undefined;
}
