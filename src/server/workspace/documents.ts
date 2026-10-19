import { defineDoc, defineDocFamily } from '@earendil-works/pi-durable';
import type {
  WorkspaceObject,
  WorkspaceAsset,
  WorkspaceOperation,
  WorkspaceReceipt,
} from '../../shared/workspace';
export type Edit = {
  before: Record<string, WorkspaceObject | null>;
  after: Record<string, WorkspaceObject | null>;
};
export type WorkspaceState = {
  objects: Record<string, WorkspaceObject>;
  assets: Record<string, WorkspaceAsset & { prefix: string }>;
  operations: Record<string, WorkspaceOperation>;
  undo: Edit[];
  redo: Edit[];
  clocks: Record<string, number>;
};
export const WorkspaceDoc = defineDoc<WorkspaceState>({
  kind: 'workspace.state',
  version: 1,
  scope: 'session',
  initial: () => ({ objects: {}, assets: {}, operations: {}, undo: [], redo: [], clocks: {} }),
});
export const WorkspaceReceipts = defineDocFamily<
  { hash: string; result: WorkspaceReceipt; completed?: boolean },
  { hash: string; result: WorkspaceReceipt; completed?: boolean }
>({
  kind: 'workspace.receipt',
  version: 1,
  scope: 'session',
  family: true,
  initial: (seed) => JSON.parse(JSON.stringify(seed)),
});
export type ReportRevision = {
  title?: string;
  summary?: string;
  source: string;
  template: string;
  dependencies: string[];
  styles: string;
  createdAt: number;
};
export const ReportSources = defineDocFamily<ReportRevision, ReportRevision>({
  kind: 'workspace.report-source',
  version: 1,
  scope: 'session',
  family: true,
  initial: (seed) => JSON.parse(JSON.stringify(seed)),
});
export const WorkspaceSelections = defineDocFamily<
  { refs: import('../../shared/workspace').FrozenWorkspaceReference[]; started: boolean },
  { refs: import('../../shared/workspace').FrozenWorkspaceReference[]; started: boolean }
>({
  kind: 'workspace.input-selection',
  version: 1,
  scope: 'session',
  family: true,
  initial: (seed) => JSON.parse(JSON.stringify(seed)),
});
