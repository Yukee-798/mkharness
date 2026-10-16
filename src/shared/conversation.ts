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
export type ConversationSnapshot = {
  entries: EntryRecord[];
  cursor?: unknown;
  history?: HistoryWindow;
  toolProgress?: ToolProgressMap;
  extensionState?: ExtensionState;
  pending: { operationId: string; status: 'running' | 'queued' }[];
  stopping: boolean;
  queue?: QueuedInput[];
  modelCatalog?: ModelCatalog;
  selection?: ModelSelection;
  runtimeIssues?: RuntimeIssue[];
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

/** Validate the owned transport envelope; Pi owns the extensible entry payload. */
export function decodeSnapshot(value: unknown): ConversationSnapshot {
  if (!value || typeof value !== 'object') throw new Error('Invalid conversation snapshot');
  const snapshot = value as ConversationSnapshot;
  if (
    !Array.isArray(snapshot.entries) ||
    !Array.isArray(snapshot.pending) ||
    typeof snapshot.stopping !== 'boolean'
  )
    throw new Error('Invalid conversation snapshot');
  for (const entry of snapshot.entries)
    if (
      !entry ||
      !Number.isSafeInteger(entry.id) ||
      Number(entry.id) < 1 ||
      (entry.model !== undefined && !Array.isArray(entry.model))
    )
      throw new Error('Invalid conversation entry');
  for (const pending of snapshot.pending)
    if (
      !pending ||
      typeof pending.operationId !== 'string' ||
      !['running', 'queued'].includes(pending.status)
    )
      throw new Error('Invalid conversation run');
  if (
    snapshot.history &&
    (!Number.isSafeInteger(snapshot.history.upperEntryId) ||
      !Number.isSafeInteger(snapshot.history.revision) ||
      !snapshot.history.annotations ||
      typeof snapshot.history.annotations !== 'object')
  )
    throw new Error('Invalid history window');
  return snapshot;
}

export type HistoryPosition = { v: 1; before: number; upper: number };
export function historyPosition(raw?: string): HistoryPosition | undefined {
  if (!raw) return;
  try {
    const value = JSON.parse(raw) as HistoryPosition;
    if (
      value.v !== 1 ||
      !Number.isSafeInteger(value.before) ||
      value.before < 1 ||
      !Number.isSafeInteger(value.upper) ||
      value.upper < value.before
    )
      throw new Error('invalid');
    return value;
  } catch {
    throw new AppError(400, 'invalid_cursor');
  }
}
