import { z } from 'zod';
import type { Json } from './json';
import { jsonText } from './json';

export const referenceSchema = z
  .object({
    objectId: z.string().min(1).max(160),
    contentVersion: z.number().int().positive(),
    anchor: z.string().max(200).optional(),
    text: z.string().max(4000).optional(),
  })
  .strict();
export type WorkspaceReference = z.infer<typeof referenceSchema>;
export const workspaceCommandSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    name: z.string().regex(/^[a-z][a-z0-9_.-]{0,100}$/),
    input: z.custom<Json>((value) => {
      try {
        jsonText(value, 1100000);
        return true;
      } catch {
        return false;
      }
    }),
    expected: z.record(z.string(), z.number().int().nonnegative()).default({}),
  })
  .strict();
export type WorkspaceCommand = z.infer<typeof workspaceCommandSchema>;
export type WorkspaceObject = {
  id: string;
  type: string;
  title: string;
  version: number;
  contentVersion: number;
  data: { [key: string]: Json };
};
export type WorkspaceAsset = {
  id: string;
  title: string;
  file: string;
  contentType: string;
  size: number;
};
export type WorkspaceOperation = {
  id: string;
  taskId: number;
  nodeId: string;
  status: string;
  code?: string;
};
export type WorkspaceReceipt = {
  status: 'committed' | 'accepted';
  objectIds: string[];
  operationId?: string;
};
export type WorkspaceSnapshot = {
  scenarioId: string;
  workspaceId: string;
  kind: string;
  watermark: number;
  objects: WorkspaceObject[];
  assets: WorkspaceAsset[];
  operations: WorkspaceOperation[];
  canUndo: boolean;
  canRedo: boolean;
};
export type ScenarioInstance = {
  titleCustom?: boolean;
  id: string;
  kind: string;
  workspaceId: string;
  mainChatId: string;
  title: string;
  updatedAt: number;
};
export type FrozenWorkspaceReference = WorkspaceReference & { title: string; summary: string };
export const assetURL = (scenarioId: string, assetId: string, download = false) =>
  `/api/scenarios/${encodeURIComponent(scenarioId)}/assets/${encodeURIComponent(assetId)}${download ? '?download=1' : ''}`;
