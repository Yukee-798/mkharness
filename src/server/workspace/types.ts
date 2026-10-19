import type { Tx, ConversationId, Harness } from '@earendil-works/pi-durable';
import type { Json } from '../../shared/json';
import type { WorkspaceObject } from '../../shared/workspace';
import type { WorkspaceState } from './documents';
import type { ImageJobCapability } from '../../extensions/images/runtime';
export type WorkspaceIdentity = {
  scenarioId: string;
  workspaceId: string;
  kind: string;
  runtimeName: string;
};
export type WorkspaceHandlerContext = {
  tx: Tx;
  state: WorkspaceState;
  requestId: string;
  nativeConversationId: ConversationId;
  identity: WorkspaceIdentity;
  images?: ImageJobCapability;
  put(
    object: Omit<WorkspaceObject, 'version' | 'contentVersion'>,
    contentChanged?: boolean,
  ): WorkspaceObject;
  remove(id: string): void;
  require(id: string, type?: string): WorkspaceObject;
  expect(id: string): void;
};
export type WorkspaceHandler = {
  undoable?: boolean;
  model?: boolean;
  invoke(
    input: Json,
    context: WorkspaceHandlerContext,
  ): Promise<{ objectIds: string[]; operationId?: string }>;
};
export type WorkspaceQuery = (
  input: Json,
  context: { pi: Harness; identity: WorkspaceIdentity; cursor?: string },
) => Promise<Json>;
export type WorkspaceServerPack = {
  id: string;
  version: string;
  /** Optional native tools/tasks/hooks/resources, installed through the existing host registry. */
  contribute?: (
    host: import('../extensions/contributions').ContributionHost,
    options: { env: Env; config: Readonly<Record<string, Json>> },
  ) =>
    | Omit<import('../extensions/contributions').ServerContribution, 'id'>
    | Promise<Omit<import('../extensions/contributions').ServerContribution, 'id'>>;
  commands: Record<string, WorkspaceHandler>;
  queries?: Record<string, WorkspaceQuery>;
  /** Merge authoritative task results when interpreting an undo/redo object snapshot. Pure. */
  restoreObject?: (object: WorkspaceObject, state: Readonly<WorkspaceState>) => WorkspaceObject;
};
