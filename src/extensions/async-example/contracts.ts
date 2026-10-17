import { z } from 'zod';
import type { RunCommand, StoredCommand } from '../../shared/contracts';

export const ASYNC_EXAMPLE_ID = 'async-example';
export const remoteActionPayload = z.object({ taskId: z.number().int().positive() }).strict();

export function remoteActionSource(
  name: 'retry' | 'recheck',
  taskId: number,
): RunCommand['source'] {
  return { action: 'extension_action', extensionId: ASYNC_EXAMPLE_ID, name, payload: { taskId } };
}

/** Decode only the current validated extension action contract. */
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
  return undefined;
}
