import {
  defineDoc,
  defineTask,
  defineTool,
  type Extension,
  type TaskId,
  type ConversationId,
  type Tx,
} from '@earendil-works/pi-durable';
import { WorkspaceDoc } from '../../server/workspace/documents';
import { Type } from '@earendil-works/pi-ai';
import type { ContributionHost, ExecutionContext } from '../../server/extensions/contributions';
import { toolRef } from '../../shared/references';
import { imageRequest, type ImageRequest, type ImageAsset } from './contracts';
import { ImageProviderRejection, type ImageProvider } from './provider';
import type { ImageFiles } from './store';

type Operation = { child: number; runId: string; status: string };
const Operations = defineDoc<{ operations: Record<string, Operation> }>({
  kind: 'images.operations',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ operations: {} }),
});
/** Receipts live in native history; finished coordination records need not grow forever. */
export async function pruneImageOperations({
  pi,
  nativeConversationId,
  context,
}: ExecutionContext) {
  const target = nativeConversationId as ConversationId;
  const saved = await pi.snapshot(Operations, target, context);
  if (!saved || !Object.keys(saved.operations).length) return;
  const finished: string[] = [];
  for (const id of Object.keys(saved.operations))
    if ((await pi.getTask(Number(id) as TaskId, context))?.state.status === 'terminal')
      finished.push(id);
  if (!finished.length) return;
  await pi.commit(async (tx) => {
    const doc = await tx.doc(Operations, target);
    for (const id of finished) delete doc.operations[id];
  }, context);
}
export type ImageJobInput = {
  workspaceOperationId?: string;
  request: ImageRequest;
  parent: number;
  prefix: string;
  provider: string;
  deadline: number;
};
type State = (
  { phase: 'submit' } | { phase: 'uncertain' } | { phase: 'poll' } | { phase: 'store' }
) & {
  remoteId: string | null;
  urls: string[];
  nextPollAt: number;
};
type Result = { ok: true; images: ImageAsset[] } | { ok: false; code: string };

/** Native child tasks persist remote receipts and wait without a browser or a second queue. */
export function imageGeneration(
  provider: ImageProvider,
  files: ImageFiles,
  host: ContributionHost,
  options: { pollMs?: number; waitMs?: number } = {},
  suppliedTask?: ReturnType<typeof createImageTask>,
): Extension {
  const task = suppliedTask ?? createImageTask(provider, files, options);
  return {
    name: 'images',
    tasks: [task],
    sections: [
      {
        key: 'image-generation',
        render: () =>
          'Use generate_image when the user asks to create an image. Do not use it for ordinary answers, charts or existing image search. Ask only for missing essentials; infer reasonable style choices. A successful result is displayed inline as an actual image with preview and download actions. Do not print Markdown images, provider URLs, base64, internal file paths or a second copy of the generated image. Normal Markdown text can precede or follow it. Never claim success before the tool succeeds. Do not automatically regenerate after a failure, timeout or unknown submission: a provider may already have charged for it. Explicit user requests may start a new generation. Stopping the local wait does not promise remote cancellation or a refund.',
      },
    ],
    tools: [
      defineTool({
        name: 'generate_image',
        callers: ['model'],
        replay: 'safe',
        description:
          'Generate an image requested by the user. Returns stored images rendered directly inside this reply; the user can click to view larger and download. One call creates one provider job. Do not silently retry errors. Default to 1K and 1:1 unless requested otherwise.',
        parameters: Type.Object({
          prompt: Type.String({ minLength: 1, maxLength: 20000 }),
          title: Type.String({ minLength: 1, maxLength: 100 }),
          aspectRatio: Type.Optional(
            Type.Union(
              [
                'auto',
                '1:1',
                '3:2',
                '2:3',
                '4:3',
                '3:4',
                '16:9',
                '9:16',
                '21:9',
                '27:16',
                '16:27',
                '9:8',
                '8:9',
              ].map((value) => Type.Literal(value)),
            ),
          ),
          resolution: Type.Optional(
            Type.Union([Type.Literal('1K'), Type.Literal('2K'), Type.Literal('4K')]),
          ),
        }),
        execute: async (raw, api, context) => {
          const request = imageRequest.parse({ aspectRatio: '1:1', resolution: '1K', ...raw });
          const command = await host.command(Number(api.conversationId));
          if (!command) throw new Error('Image generation requires an accepted user request');
          const calling = await api.getTask(api.taskId, context);
          const input = calling?.input as { kind?: string; assistant?: number } | undefined;
          if (input?.kind !== 'model' || !input.assistant)
            throw new Error('Missing image calling entry');
          const ref = toolRef(input.assistant, api.callId);
          const prefix = `images/${encodeURIComponent(host.identity)}/${api.conversationId}/${api.taskId}`;
          const child = await api.commit(async (tx) => {
            const doc = await tx.doc(Operations, api.conversationId);
            const existing = doc.operations[api.taskId];
            if (existing) return existing.child as TaskId<Result>;
            if (
              Object.values(doc.operations).some(
                (operation) =>
                  operation.runId === command.runId && operation.status !== 'completed',
              )
            )
              throw new Error(
                'Image generation is already pending or failed. Do not automatically retry in this reply.',
              );
            const child = await tx.createTask(
              task,
              {
                request,
                parent: Number(api.taskId),
                prefix,
                provider: provider.identity,
                deadline: Date.now() + (options.waitMs ?? 600000),
              },
              { ownership: { kind: 'task', taskId: api.taskId } },
            );
            doc.operations[api.taskId] = {
              child: Number(child),
              runId: command.runId,
              status: 'pending',
            };
            return child;
          }, context);
          const settled = await api.waitForTask(child, context);
          const result = settled.state.outcome.result;
          if (!result?.ok)
            return {
              isError: true,
              output: [{ type: 'text', text: result?.code ?? 'image_generation_failed' }],
            };
          const value = { ref, title: request.title, images: result.images };
          return {
            output: [{ type: 'text', text: JSON.stringify(value) }],
            details: { ...value, prefix },
          };
        },
      }),
    ],
  };
}

export function createImageTask(
  provider: ImageProvider,
  files: ImageFiles,
  options: { pollMs?: number; waitMs?: number } = {},
) {
  return defineTask<ImageJobInput, State, Result, Record<string, never>>({
    name: 'images.generate',
    version: 1,
    initial: () => ({ phase: 'submit', remoteId: null, urls: [], nextPollAt: 0 }),
    phases: {
      submit: async (current, runtime, context) => {
        const fail = (code: string) =>
          runtime.commit(async (tx) => {
            await settleImageOperation(tx, runtime.conversationId, current.input, code);
            return {
              status: 'terminal',
              outcome: { status: 'completed', result: { ok: false, code } },
            };
          }, context);
        if (current.input.provider !== provider.identity)
          return fail('image_configuration_changed');
        if (runtime.now() >= current.input.deadline) return fail('image_generation_timeout');
        // Kie does not document idempotent submission. Persist this fence before POST.
        await runtime.commit(
          () => ({
            status: 'running',
            checkpoint: { ...current.state.checkpoint, phase: 'uncertain' },
          }),
          context,
        );
        let remoteId: string;
        try {
          remoteId = await provider.submit(current.input.request, runtime.signal);
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          return fail(
            error instanceof ImageProviderRejection ? error.message : 'image_submission_unknown',
          );
        }
        await runtime.commit(
          () => ({
            status: 'running',
            checkpoint: { ...current.state.checkpoint, phase: 'poll', remoteId },
          }),
          context,
        );
      },
      uncertain: async (current, runtime, context) =>
        runtime.commit(async (tx) => {
          await settleImageOperation(
            tx,
            runtime.conversationId,
            current.input,
            'image_submission_unknown',
          );
          return {
            status: 'terminal',
            outcome: {
              status: 'completed',
              result: { ok: false, code: 'image_submission_unknown' },
            },
          };
        }, context),
      poll: async (current, runtime, context) => {
        const fail = (code: string) =>
          runtime.commit(async (tx) => {
            await settleImageOperation(tx, runtime.conversationId, current.input, code);
            return {
              status: 'terminal',
              outcome: { status: 'completed', result: { ok: false, code } },
            };
          }, context);
        if (current.input.provider !== provider.identity)
          return fail('image_configuration_changed');
        if (runtime.now() < current.state.checkpoint.nextPollAt)
          await runtime.sleep(current.state.checkpoint.nextPollAt, context);
        if (runtime.now() >= current.input.deadline) return fail('image_generation_timeout');
        try {
          const result = await provider.inspect(current.state.checkpoint.remoteId!, runtime.signal);
          if (result.status === 'failed') return fail('image_generation_failed');
          if (result.status === 'succeeded') {
            await runtime.commit(
              () => ({
                status: 'running',
                checkpoint: { ...current.state.checkpoint, phase: 'store', urls: result.urls },
              }),
              context,
            );
            return;
          }
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          if (error instanceof ImageProviderRejection) return fail('image_provider_rejected');
          // GET may be retried; POST may not. The persisted remote ID is retained.
        }
        await runtime.commit(
          () => ({
            status: 'running',
            checkpoint: {
              ...current.state.checkpoint,
              nextPollAt: Math.min(
                current.input.deadline,
                runtime.now() + (options.pollMs ?? 3000),
              ),
            },
          }),
          context,
        );
      },
      store: async (current, runtime, context) => {
        let images: ImageAsset[];
        try {
          images =
            (await files.saved(current.input.prefix)) ??
            (await files.save(current.input.prefix, current.state.checkpoint.urls, runtime.signal));
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          // Bounded read retries keep the paid job; never submit a replacement generation.
          if (runtime.now() < current.input.deadline) {
            await runtime.sleep(
              Math.min(current.input.deadline, runtime.now() + (options.pollMs ?? 3000)),
              context,
            );
            return;
          }
          await runtime.commit(async (tx) => {
            await settleImageOperation(
              tx,
              runtime.conversationId,
              current.input,
              'image_download_failed',
            );
            return {
              status: 'terminal',
              outcome: {
                status: 'completed',
                result: { ok: false, code: 'image_download_failed' },
              },
            };
          }, context);
          return;
        }
        await runtime.commit(async (tx) => {
          await settleImageOperation(
            tx,
            runtime.conversationId,
            current.input,
            'completed',
            images,
          );
          return {
            status: 'terminal',
            outcome: { status: 'completed', result: { ok: true, images } },
          };
        }, context);
      },
    },
    abort: async (current, runtime, context) =>
      runtime.commit(async (tx) => {
        await settleImageOperation(tx, runtime.conversationId, current.input, 'image_wait_stopped');
        return {
          status: 'terminal',
          outcome: { status: 'aborted', result: { ok: false, code: 'image_wait_stopped' } },
        };
      }, context),
  });
}

export type ImageJobCapability = { task: ReturnType<typeof createImageTask>; provider: string };
async function settleImageOperation(
  tx: Tx,
  target: ConversationId,
  input: ImageJobInput,
  status: string,
  images?: ImageAsset[],
) {
  if (!input.workspaceOperationId) {
    (await tx.doc(Operations, target)).operations[input.parent]!.status = status;
    if (images) {
      const state = await tx.doc(WorkspaceDoc);
      for (const [index, image] of images.entries()) {
        const id = `image:${input.parent}:${index}`;
        if (Object.keys(state.assets).length < 300)
          state.assets[id] = {
            id,
            title: input.request.title,
            prefix: input.prefix,
            file: image.file,
            contentType: image.mediaType,
            size: image.bytes,
          };
      }
    }
    return;
  }
  const state = await tx.doc(WorkspaceDoc),
    operation = state.operations[input.workspaceOperationId];
  if (!operation) throw new Error('Workspace image receipt missing');
  operation.status = status === 'completed' ? 'completed' : 'failed';
  if (status !== 'completed') operation.code = status;
  const assetIds = (images ?? []).map((image, index) => {
    const id = `${operation.id}:${index}`;
    state.assets[id] = {
      id,
      title: input.request.title,
      prefix: input.prefix,
      file: image.file,
      contentType: image.mediaType,
      size: image.bytes,
    };
    return id;
  });
  const node = state.objects[operation.nodeId];
  // Deleted nodes stay deleted; storage results still belong to this project.
  if (node && node.data.operationId === operation.id) {
    const version = (state.clocks[node.id] ?? 0) + 1;
    state.clocks[node.id] = version;
    state.objects[node.id] = {
      ...node,
      version,
      contentVersion: version,
      data: {
        ...node.data,
        kind: images?.length ? 'image' : 'failed',
        ...(assetIds[0] ? { assetId: assetIds[0] } : { error: status }),
      },
    };
  }
}
