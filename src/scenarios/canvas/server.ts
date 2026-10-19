import { canvasManifest } from './manifest';
import { z } from 'zod';
import { AppError } from '../../shared/contracts';
import { imageRequest } from '../../extensions/images/contracts';
import type { WorkspaceServerPack } from '../../server/workspace/types';
const id = z.string().min(1).max(160);
const position = z.object({
  x: z.number().finite().min(-100000).max(100000),
  y: z.number().finite().min(-100000).max(100000),
});
export const canvasServer = {
  id: 'canvas',
  version: canvasManifest.version,
  restoreObject(object, state) {
    if (object.type !== 'canvas.node' || typeof object.data.operationId !== 'string') return object;
    const operation = state.operations[object.data.operationId];
    if (!operation || operation.nodeId !== object.id) return object;
    const asset = state.assets[`${operation.id}:0`];
    if (operation.status === 'completed' && asset)
      return { ...object, data: { ...object.data, kind: 'image', assetId: asset.id } };
    if (operation.status === 'failed')
      return {
        ...object,
        data: {
          ...object.data,
          kind: 'failed',
          error: operation.code ?? 'image_generation_failed',
        },
      };
    return object;
  },
  commands: {
    'canvas.add': {
      undoable: true,
      model: true,
      async invoke(raw, c) {
        const value = z
          .object({
            id: id.optional(),
            title: z.string().trim().min(1).max(120),
            text: z.string().max(10000).default(''),
            assetId: id.optional(),
            parentId: id.optional(),
            position: position.default({ x: 0, y: 0 }),
          })
          .strict()
          .parse(raw);
        const nodeId = value.id ?? crypto.randomUUID();
        if (c.state.objects[nodeId] || c.state.clocks[nodeId])
          throw new AppError(409, 'object_exists');
        if (value.assetId && !c.state.assets[value.assetId])
          throw new AppError(404, 'asset_not_found');
        if (value.parentId) c.require(value.parentId, 'canvas.node');
        c.put({
          id: nodeId,
          title: value.title,
          type: 'canvas.node',
          data: {
            kind: value.assetId ? 'image' : 'text',
            text: value.text,
            position: value.position,
            ...(value.assetId ? { assetId: value.assetId } : {}),
            ...(value.parentId ? { parentId: value.parentId } : {}),
          },
        });
        return { objectIds: [nodeId] };
      },
    },
    'canvas.update': {
      undoable: true,
      model: true,
      async invoke(raw, c) {
        const value = z
          .object({
            ids: z.array(id).min(1).max(100),
            title: z.string().trim().min(1).max(120).optional(),
            text: z.string().max(10000).optional(),
            selected: z.boolean().optional(),
            group: z.string().max(160).optional(),
            positions: z.record(z.string(), position).optional(),
          })
          .strict()
          .parse(raw);
        for (const nodeId of value.ids) {
          const node = c.require(nodeId, 'canvas.node');
          c.expect(nodeId);
          const data = { ...node.data };
          if (value.text !== undefined) data.text = value.text;
          if (value.selected !== undefined) data.selected = value.selected;
          if (value.group !== undefined) data.group = value.group;
          if (value.positions?.[nodeId]) data.position = value.positions[nodeId];
          c.put(
            { ...node, title: value.title ?? node.title, data },
            value.title !== undefined || value.text !== undefined,
          );
        }
        return { objectIds: value.ids };
      },
    },
    'canvas.remove': {
      undoable: true,
      model: true,
      async invoke(raw, c) {
        const { ids } = z
          .object({ ids: z.array(id).min(1).max(100) })
          .strict()
          .parse(raw);
        for (const nodeId of ids) {
          c.require(nodeId, 'canvas.node');
          c.expect(nodeId);
          c.remove(nodeId);
        }
        return { objectIds: ids };
      },
    },
    'canvas.generate': {
      model: true,
      async invoke(raw, c) {
        const value = imageRequest
          .extend({ parentId: id.optional(), position: position.default({ x: 0, y: 0 }) })
          .strict()
          .parse(raw);
        if (!c.images)
          throw new AppError(503, 'image_provider_unavailable', '请先配置图片 Provider');
        if (
          Object.keys(c.state.operations).length >= 300 ||
          Object.keys(c.state.assets).length >= 300
        )
          throw new AppError(409, 'workspace_capacity');
        if (value.parentId) {
          c.require(value.parentId, 'canvas.node');
          c.expect(value.parentId);
        }
        const nodeId = crypto.randomUUID(),
          operationId = crypto.randomUUID();
        c.put({
          id: nodeId,
          type: 'canvas.node',
          title: value.title,
          data: {
            kind: 'pending',
            position: value.position,
            operationId,
            ...(value.parentId ? { parentId: value.parentId } : {}),
          },
        });
        const prefix = `images/${encodeURIComponent(c.identity.runtimeName)}/workspace/${operationId}`;
        const taskId = await c.tx.createTask(
          c.images.task,
          {
            request: imageRequest.parse(value),
            parent: 0,
            prefix,
            provider: c.images.provider,
            deadline: Date.now() + 600000,
            workspaceOperationId: operationId,
          },
          {
            ownership: { kind: 'conversation' },
            conversationId: c.nativeConversationId,
            background: true,
          },
        );
        c.state.operations[operationId] = {
          id: operationId,
          taskId: Number(taskId),
          nodeId,
          status: 'pending',
        };
        return { objectIds: [nodeId], operationId };
      },
    },
  },
} satisfies WorkspaceServerPack;
