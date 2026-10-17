import { defineDoc } from '@earendil-works/pi-durable';

export type RemoteIntent = {
  taskId: number;
  childTaskId: number;
  runId: string;
  callId: string;
  service: string;
  toolName: string;
  fingerprint: string;
  key: string;
  remoteId: string | null;
  status: string;
  remoteStatus: string;
  deadline: number;
  nextPollAt: number;
  retryRunId: string | null;
  retryTaskId: number | null;
};

/** Provider-specific intent data, scoped to its owning native conversation. */
export const RemoteIntents = defineDoc<{
  operations: Record<string, RemoteIntent>;
}>({
  kind: 'app.remote-intents',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ operations: {} }),
});
