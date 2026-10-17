import { defineDoc, defineDocFamily } from '@earendil-works/pi-durable';

export type AdmissionReceipt = {
  hash: string;
  state: 'prepared' | 'admitted' | 'withdrawn';
  conversationId: number;
  requestId: string;
  pendingInput?: string;
  submissionId?: number;
  antecedents?: number[];
};
/** A compact receipt per request; completed receipts retain no user payload. */
export const Admissions = defineDocFamily<AdmissionReceipt, AdmissionReceipt>({
  kind: 'app.admission',
  version: 1,
  scope: 'session',
  family: true,
  initial: (seed) => structuredClone(seed),
});
export const PendingAdmissions = defineDoc<{ keys: string[] }>({
  kind: 'app.pending-admissions',
  version: 1,
  scope: 'session',
  initial: () => ({ keys: [] }),
});
export const ExecutionBinding = defineDocFamily<{ execution: string }, string>({
  kind: 'app.execution-binding',
  version: 1,
  scope: 'session',
  family: true,
  initial: (execution) => ({ execution }),
});
export const ConversationControl = defineDoc<{ stopping: boolean }>({
  kind: 'app.control',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ stopping: false }),
});
export const admissionKey = (conversationId: number, requestId: string) =>
  `${conversationId}:${requestId}`;
export const bindingKey = (provider: string, modelId: string) =>
  JSON.stringify([provider, modelId]);

/** Native provider identity resolves a model attempt to its actual conversation, including compaction and forks. */
export const ModelTarget = defineDocFamily<{ conversationId: number }, { conversationId: number }>({
  kind: 'app.model-target',
  version: 1,
  scope: 'session',
  family: true,
  initial: (seed) => ({ ...seed }),
});

export type QueueEditReceipt = {
  submissionId: number;
  conversationId: number;
  runId: string;
  state: 'prepared' | 'edited' | 'acknowledged' | 'expired' | 'started';
  expiresAt: number;
  draft?: string;
};
/** A withdrawn input's transfer receipt, never an executable input queue. */
export const QueueEdits = defineDocFamily<QueueEditReceipt, QueueEditReceipt | null>({
  kind: 'app.queue-edit',
  version: 1,
  scope: 'session',
  family: true,
  initial: (seed) => {
    if (!seed) throw new Error('Queue edit receipt missing');
    return structuredClone(seed);
  },
});
export const UnclaimedQueueEdits = defineDoc<{ keys: string[] }>({
  kind: 'app.unclaimed-queue-edits',
  version: 1,
  scope: 'session',
  initial: () => ({ keys: [] }),
});
