import { defineDoc } from '@earendil-works/pi-durable';
import type { Json } from '../../shared/json';

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

/** Preserve the deployed native document identity and its unrelated MCP field. */
export const RemoteIntents = defineDoc<{
  operations: Record<string, RemoteIntent>;
  mcp?: Record<string, Json>;
}>({
  kind: 'app.remote-intents',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ operations: {} }),
});
