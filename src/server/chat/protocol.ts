import type { RunCommand } from '../../shared/contracts';
import type { QueueAction } from '../../shared/queue';
import type { Json } from '../../shared/json';

/** Constructed from the owned D1 row by the Worker, never from request data. */
export type ChatActor = { chatId: string; ownerId: string; generation: string };

// An omitted target is resolved to the manifest's main conversation only at the DO edge.
type Target = { target?: number };
export type ChatCommand = Target &
  (
    | { type: 'submit'; command: RunCommand }
    | { type: 'queue'; runId: string; action: QueueAction }
    | { type: 'acknowledge_queue_edit'; runId: string }
    | { type: 'stop' }
    | { type: 'delete' }
    | { type: 'extension_control'; extensionId: string; name: string; payload: string }
    | {
        type: 'save_resource_state';
        extensionId: string;
        ref: string;
        state: Json;
        expectedRevision: number;
      }
  );

export type ChatReadQuery = Target &
  (
    | { type: 'snapshot' }
    | { type: 'history'; cursor?: string }
    | { type: 'resource'; extensionId: string; ref: string }
  );
export type ChatObservationQuery = Target & { runId: string };
