import { exampleManifest } from './manifest';
import { z } from 'zod';
import type { WorkspaceServerPack } from '../../server/workspace/types';
/** A custom command can join an existing scene without a host business branch. */
export const exampleWorkspacePack = {
  id: 'example-workspace',
  version: exampleManifest.version,
  commands: {
    'example.note': {
      undoable: true,
      model: true,
      async invoke(input, context) {
        const { title } = z.object({ title: z.string().min(1).max(100) }).parse(input);
        const id = crypto.randomUUID();
        context.put({
          id,
          type: 'canvas.node',
          title,
          data: { kind: 'text', text: 'Created by a trusted scene pack', position: { x: 0, y: 0 } },
        });
        return { objectIds: [id] };
      },
    },
  },
} satisfies WorkspaceServerPack;
