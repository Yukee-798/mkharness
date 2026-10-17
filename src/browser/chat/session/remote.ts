import { request } from '../../api';
import { decodeHistoryPage, type HistoryPage } from '../../../shared/conversation';
import type { QueueAction, QueueActionResult } from '../../../shared/queue';
import type { CreateConversationRequest, RunCommand } from '../../../shared/contracts';
import { loadSnapshot } from './snapshot';
export type ConversationRemote = {
  snapshot: typeof loadSnapshot;
  history: (
    id: string,
    cursor: string,
    signal?: AbortSignal,
    target?: number,
  ) => Promise<HistoryPage>;
  queue: (
    id: string,
    runId: string,
    action: QueueAction,
    target?: number,
  ) => Promise<QueueActionResult>;
  acknowledgeQueueEdit: (id: string, runId: string, target?: number) => Promise<unknown>;
  stop: (id: string, target?: number) => Promise<unknown>;
  create: (creation: CreateConversationRequest) => Promise<{ id: string }>;
  submit: (id: string, command: RunCommand, target?: number) => Promise<unknown>;
  observe: (id: string, runId: string, signal: AbortSignal, target?: number) => Promise<Response>;
};
const targetQuery = (target?: number) => (target === undefined ? '' : 'conversationId=' + target);
const path = (id: string) => '/conversations/' + encodeURIComponent(id);
export const conversationRemote: ConversationRemote = {
  snapshot: loadSnapshot,
  async history(id, cursor, signal, target) {
    const page = await request<unknown>(
      `${path(id)}/history?cursor=${encodeURIComponent(cursor)}${target === undefined ? '' : '&' + targetQuery(target)}`,
      { signal },
    );
    return decodeHistoryPage(page);
  },
  queue: (id, runId, action, target) =>
    request(
      `${path(id)}/runs/${encodeURIComponent(runId)}/queue${target === undefined ? '' : '?' + targetQuery(target)}`,
      {
        method: 'POST',
        body: JSON.stringify({ action }),
      },
    ),
  acknowledgeQueueEdit: (id, runId, target) =>
    request(
      `${path(id)}/runs/${encodeURIComponent(runId)}/queue/ack${target === undefined ? '' : '?' + targetQuery(target)}`,
      { method: 'POST' },
    ),
  stop: (id, target) =>
    request(`${path(id)}/stop${target === undefined ? '' : '?' + targetQuery(target)}`, {
      method: 'POST',
    }),
  create: (creation) =>
    request('/conversations', {
      method: 'POST',
      body: JSON.stringify(creation),
    }),
  submit: (id, command, target) =>
    request(`${path(id)}/runs${target === undefined ? '' : '?' + targetQuery(target)}`, {
      method: 'POST',
      body: JSON.stringify(command),
    }),
  observe: (id, runId, signal, target) =>
    fetch(
      `/api${path(id)}/runs/${encodeURIComponent(runId)}/events${target === undefined ? '' : '?' + targetQuery(target)}`,
      { signal, headers: { Accept: 'text/event-stream' } },
    ),
};
