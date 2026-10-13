import { defineDoc, type TaskRecord } from '@earendil-works/pi-durable';

export type McpIntent = {
  taskId: number;
  runId: string;
  callId: string;
  serverId: string;
  endpoint: string;
  toolName: string;
  status: 'dispatching' | 'responded' | 'unknown';
};

/** A valid response is not yet published until Pi atomically settles its tool task.
 * Never copy the response here: native task/result history remains authoritative.
 */
export function mcpIntentUnresolved(
  intent: McpIntent,
  task?: Pick<TaskRecord<unknown, unknown, unknown>, 'state'>,
): boolean {
  return (
    intent.status !== 'responded' ||
    task?.state.status !== 'terminal' ||
    task.state.outcome.status !== 'completed' ||
    !task.state.outcome.result ||
    typeof (task.state.outcome.result as { entryId?: unknown }).entryId !== 'number'
  );
}

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
export const RemoteIntents = defineDoc<{
  operations: Record<string, RemoteIntent>;
  mcp?: Record<string, McpIntent>;
}>({
  kind: 'app.remote-intents',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ operations: {} }),
});
