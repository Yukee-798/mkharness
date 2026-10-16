import { request } from '../../api';
import { decodeSnapshot, type HistoryPage } from '../../../shared/conversation';
import type { QueueAction, QueueActionResult } from '../../../shared/queue';
import type { RunCommand } from '../../../shared/contracts';
import type { Json } from '../../../shared/json';
import { loadSnapshot } from './snapshot';
export type ConversationRemote = {
  snapshot: typeof loadSnapshot;
  history: (id: string, cursor: string, signal?: AbortSignal) => Promise<HistoryPage>;
  queue: (id: string, runId: string, action: QueueAction) => Promise<QueueActionResult>;
  stop: (id: string) => Promise<unknown>;
  create: (creation?: Record<string, Json>) => Promise<{ id: string }>;
  submit: (id: string, command: RunCommand) => Promise<unknown>;
};
export const conversationRemote: ConversationRemote = {
  snapshot: loadSnapshot,
  async history(id, cursor, signal) {
    const page = await request<HistoryPage>(
      `/conversations/${id}/history?cursor=${encodeURIComponent(cursor)}`,
      { signal },
    );
    const decoded = decodeSnapshot({ ...page, pending: [], stopping: false });
    if (!decoded.history) throw new Error('Invalid history page');
    return { ...page, history: decoded.history };
  },
  queue: (id, runId, action) =>
    request(`/conversations/${id}/runs/${runId}/queue`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    }),
  stop: (id) => request(`/conversations/${id}/stop`, { method: 'POST' }),
  create: (creation) =>
    request('/conversations', {
      method: 'POST',
      ...(creation ? { body: JSON.stringify(creation) } : {}),
    }),
  submit: (id, command) =>
    request(`/conversations/${id}/runs`, { method: 'POST', body: JSON.stringify(command) }),
};
