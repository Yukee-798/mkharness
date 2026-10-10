/** Browser-safe committed progress; remote IDs, keys, credentials and bodies remain server-side. */
export type RemoteProgress = {
  taskId: number;
  runId: string;
  status: string;
  remoteStatus: string;
  deadline: number;
};
export function remoteProgress(operations: Readonly<Record<string, RemoteProgress>>) {
  return Object.values(operations)
    .slice(-50)
    .map(({ taskId, runId, status, remoteStatus, deadline }) => ({
      taskId,
      runId,
      status,
      remoteStatus,
      deadline,
    }));
}
