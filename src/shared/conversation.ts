import type { EntryRecord } from '@earendil-works/pi-durable';
import type { QueuedInput } from './queue';
import type { ModelCatalog, ModelSelection } from './model-selection';
import type { RuntimeIssue } from './runtime-issues';
import type { ToolProgressMap } from './tool-progress';
import type { ExtensionState } from './extension-state';
import { AppError } from './contracts';

export type HistoryAnnotations = Record<string, ExtensionState>;
export type HistoryWindow = {
  olderCursor?: string;
  upperEntryId: number;
  revision: number;
  annotations: HistoryAnnotations;
};
export type HistoryPage = {
  entries: EntryRecord[];
  history: HistoryWindow;
  toolProgress?: ToolProgressMap;
};
/** Unclaimed draft transfers; discovery never exposes or executes their input. */
export type QueueEditRecovery = { runId: string; expiresAt: number };
export type ConversationSnapshot = {
  conversationId: number;
  entries: EntryRecord[];
  history: HistoryWindow;
  toolProgress?: ToolProgressMap;
  extensionState?: ExtensionState;
  pending: { operationId: string; status: 'running' | 'queued' }[];
  stopping: boolean;
  queue: QueuedInput[];
  queueEdits: QueueEditRecovery[];
  modelCatalog?: ModelCatalog;
  selection?: ModelSelection;
  runtimeIssues?: RuntimeIssue[];
  capabilityIssues?: unknown;
};
export type ObservationState = {
  runId?: string;
  extensionStateRevision?: number;
  messageIds?: Record<string, string>;
  toolProgress?: ToolProgressMap;
  extensionState?: ExtensionState;
  runtimeIssues?: RuntimeIssue[];
  queue?: QueuedInput[];
  history?: HistoryWindow;
};

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, min = 0): value is number =>
  Number.isSafeInteger(value) && Number(value) >= min;
function mismatch(): never {
  throw new Error('protocol_mismatch: Refresh to load the current chat protocol.');
}
function page(value: unknown): asserts value is HistoryPage {
  if (!object(value) || !Array.isArray(value.entries) || !object(value.history)) mismatch();
  for (const entry of value.entries)
    if (
      !object(entry) ||
      !integer(entry.id, 1) ||
      !integer(entry.conversationId, 1) ||
      typeof entry.kind !== 'string' ||
      (entry.model !== undefined && !Array.isArray(entry.model))
    )
      mismatch();
  const history = value.history;
  if (
    !integer(history.upperEntryId) ||
    !integer(history.revision) ||
    !object(history.annotations) ||
    (history.olderCursor !== undefined &&
      (typeof history.olderCursor !== 'string' || !history.olderCursor.length)) ||
    Object.keys(history).some(
      (key) => !['upperEntryId', 'revision', 'annotations', 'olderCursor'].includes(key),
    )
  )
    mismatch();
  let previous = 0;
  for (const entry of value.entries) {
    if (entry.id <= previous || entry.id > history.upperEntryId) mismatch();
    previous = entry.id;
  }
  const ids = new Set(value.entries.map((entry) => String(entry.id)));
  for (const [id, annotation] of Object.entries(history.annotations))
    if (!ids.has(id) || !object(annotation)) mismatch();
  if (value.toolProgress !== undefined && !object(value.toolProgress)) mismatch();
}
/** Validate our one transport envelope; Pi retains ownership of entry payload shapes. */
export function decodeSnapshot(value: unknown): ConversationSnapshot {
  page(value);
  const snapshot = value as unknown as ConversationSnapshot;
  if (
    !integer(snapshot.conversationId, 1) ||
    !Array.isArray(snapshot.pending) ||
    !Array.isArray(snapshot.queue) ||
    !Array.isArray(snapshot.queueEdits) ||
    snapshot.queueEdits.length > 32 ||
    typeof snapshot.stopping !== 'boolean' ||
    Object.keys(snapshot).some(
      (key) =>
        ![
          'conversationId',
          'entries',
          'history',
          'toolProgress',
          'extensionState',
          'pending',
          'stopping',
          'queue',
          'queueEdits',
          'modelCatalog',
          'selection',
          'runtimeIssues',
          'capabilityIssues',
        ].includes(key),
    )
  )
    mismatch();
  for (const pending of snapshot.pending)
    if (
      !object(pending) ||
      typeof pending.operationId !== 'string' ||
      !['running', 'queued'].includes(pending.status)
    )
      mismatch();
  for (const queued of snapshot.queue)
    if (
      !object(queued) ||
      typeof queued.runId !== 'string' ||
      typeof queued.text !== 'string' ||
      !['followUp', 'steer'].includes(queued.mode)
    )
      mismatch();
  const edits = new Set<string>();
  for (const edit of snapshot.queueEdits) {
    if (
      !object(edit) ||
      typeof edit.runId !== 'string' ||
      !edit.runId.length ||
      !integer(edit.expiresAt, 1) ||
      edits.has(edit.runId) ||
      Object.keys(edit).some((key) => !['runId', 'expiresAt'].includes(key))
    )
      mismatch();
    edits.add(edit.runId);
  }
  if (snapshot.extensionState !== undefined && !object(snapshot.extensionState)) mismatch();
  if (snapshot.runtimeIssues !== undefined && !Array.isArray(snapshot.runtimeIssues)) mismatch();
  return snapshot;
}
export function decodeHistoryPage(value: unknown): HistoryPage {
  page(value);
  if (Object.keys(value).some((key) => !['entries', 'history', 'toolProgress'].includes(key)))
    mismatch();
  return value;
}

export type HistoryPosition = {
  v: 1;
  chatId: string;
  conversationId: number;
  before: number;
  upper: number;
};
export function encodeHistoryPosition(position: HistoryPosition) {
  return btoa(JSON.stringify(position))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}
export function historyPosition(
  raw: string | undefined,
  chatId: string,
  conversationId: number,
): HistoryPosition | undefined {
  if (raw === undefined) return;
  try {
    if (!raw || raw.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error('invalid');
    const value = JSON.parse(
      atob(raw.replaceAll('-', '+').replaceAll('_', '/')),
    ) as HistoryPosition;
    if (
      !object(value) ||
      value.v !== 1 ||
      value.chatId !== chatId ||
      value.conversationId !== conversationId ||
      !integer(value.before, 1) ||
      !integer(value.upper, value.before) ||
      Object.keys(value).length !== 5
    )
      throw new Error('invalid');
    return value;
  } catch {
    throw new AppError(400, 'invalid_cursor');
  }
}
