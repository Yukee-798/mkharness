import { defineDoc } from '@earendil-works/pi-durable';

export type McpRequest = {
  taskId: number;
  parentId: number;
  connectionId: string;
  connectionName: string;
  toolName: string;
  args: string;
  status: 'pending' | 'approved' | 'rejected' | 'dispatching' | 'completed' | 'unknown' | 'stopped';
  deadline: number;
};
export const McpRequests = defineDoc<{ requests: Record<string, McpRequest> }>({
  kind: 'app.mcp-requests',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ requests: {} }),
});
