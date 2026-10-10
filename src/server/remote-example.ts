import { Type } from '@earendil-works/pi-ai';
import {
  defineDoc,
  defineTask,
  defineTool,
  hook,
  ToolTask,
  type Extension,
  type TaskId,
} from '@earendil-works/pi-durable';
import { AppError } from '../shared/contracts';
import { canonicalJson, jsonText, finiteJson, type Json } from '../shared/compute';
import { boundedText } from './web';

export type RemoteIntent = {
  taskId: number;
  childTaskId: number;
  runId: string;
  callId: string;
  service: string;
  toolName: string;
  fingerprint: string;
  key: string;
  remoteId: string | null;
  status: string;
  remoteStatus: string;
  deadline: number;
  nextPollAt: number;
  retryRunId: string | null;
  retryTaskId: number | null;
};
export const RemoteIntents = defineDoc<{ operations: Record<string, RemoteIntent> }>({
  kind: 'app.remote-intents',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ operations: {} }),
});
export const remoteBlocked = (operation: RemoteIntent) =>
  ['unknown', 'timeout', 'cancel_unknown', 'cancel_failed', 'cancel_unsupported'].includes(
    operation.status,
  );
export type RemoteConfig = {
  endpoint: string;
  token?: string;
  recovery: 'none' | 'key' | 'lookup';
  waitMs?: number;
  requestMs?: number;
  pollMs?: number[];
};
type Input = { prompt: string; parentId: number; key: string; deadline: number };
type State = ({ phase: 'prepare' } | { phase: 'recover-submit' } | { phase: 'poll' }) & {
  deadline: number;
  nextPollAt: number;
  attempt: number;
};
type Result = { ok: true; value: Json } | { ok: false; code: string };
export function remoteConfiguration(env: Record<string, unknown>): RemoteConfig | undefined {
  if (!env.ASYNC_SERVICE_URL) return;
  let endpoint: URL;
  try {
    endpoint = new URL(String(env.ASYNC_SERVICE_URL));
  } catch {
    throw new AppError(503, 'remote_configuration_invalid');
  }
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new AppError(503, 'remote_configuration_invalid');
  const recovery = env.ASYNC_RECOVERY ?? 'none';
  if (!['none', 'key', 'lookup'].includes(recovery as string))
    throw new AppError(503, 'remote_configuration_invalid');
  return {
    endpoint: endpoint.href.replace(/\/$/, ''),
    token: typeof env.ASYNC_SERVICE_TOKEN === 'string' ? env.ASYNC_SERVICE_TOKEN : undefined,
    recovery: recovery as RemoteConfig['recovery'],
  };
}

/** Concrete example service, not a generic job scheduler or SDK. Pi owns its durable state. */
export function remoteExample(
  config: RemoteConfig,
  host: { identity: string; runId: () => Promise<string> },
): Extension {
  const intervals = config.pollMs ?? [1000, 2000, 5000, 10000, 15000];
  if (!intervals.length || intervals.some((ms) => !Number.isFinite(ms) || ms <= 0))
    throw new AppError(503, 'remote_configuration_invalid');
  async function request(
    path: string,
    method: string,
    signal: AbortSignal,
    body?: Json,
    key?: string,
    deadline?: number,
  ): Promise<Record<string, Json>> {
    const response = await fetch(config.endpoint + path, {
      method,
      redirect: 'manual',
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(
          Math.max(
            1,
            Math.min(
              config.requestMs ?? 30000,
              deadline === undefined ? Infinity : deadline - Date.now(),
            ),
          ),
        ),
      ]),
      headers: {
        'Content-Type': 'application/json',
        ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      ...(body === undefined ? {} : { body: jsonText(body) }),
    });
    if (response.status >= 300 && response.status < 400)
      throw new AppError(503, 'remote_redirect_blocked');
    if (method === 'DELETE' && [405, 409, 501].includes(response.status))
      throw new AppError(503, 'remote_cancel_unsupported');
    if (!response.ok)
      throw new AppError(
        503,
        response.status === 401 || response.status === 403
          ? 'remote_unauthorized'
          : 'remote_request_failed',
      );
    const raw: unknown = JSON.parse(await boundedText(response, 1024 * 1024));
    finiteJson(raw);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new AppError(503, 'remote_response_invalid');
    return raw;
  }
  const task = defineTask<Input, State, Result, Record<string, never>>({
    name: 'app.remote-example',
    version: 1,
    initial: (input) => ({ phase: 'prepare', deadline: input.deadline, nextPollAt: 0, attempt: 0 }),
    phases: {
      prepare: async (current, runtime, context) => {
        if (runtime.now() >= current.input.deadline) {
          await runtime.commit(async (tx) => {
            (await tx.doc(RemoteIntents, runtime.conversationId)).operations[
              current.input.parentId
            ].status = 'timeout';
            return {
              status: 'terminal',
              outcome: { status: 'completed', result: { ok: false, code: 'remote_wait_timeout' } },
            };
          }, context);
          return;
        }
        await runtime.commit(async (tx) => {
          (await tx.doc(RemoteIntents, runtime.conversationId)).operations[
            current.input.parentId
          ].status = 'submitting';
          return {
            status: 'running',
            checkpoint: { ...current.state.checkpoint, phase: 'recover-submit' },
          };
        }, context);
        try {
          const response = await request(
            '/requests',
            'POST',
            runtime.signal,
            { prompt: current.input.prompt },
            current.input.key,
            current.input.deadline,
          );
          if (typeof response.id !== 'string' || !response.id || response.id.length > 512)
            throw new AppError(503, 'remote_response_invalid');
          await runtime.commit(async (tx) => {
            const operation = (await tx.doc(RemoteIntents, runtime.conversationId)).operations[
              current.input.parentId
            ];
            operation.remoteId = response.id as string;
            operation.status = 'waiting';
            operation.remoteStatus = 'pending';
            return {
              status: 'running',
              checkpoint: { ...current.state.checkpoint, phase: 'poll' },
            };
          }, context);
        } catch (e) {
          if (runtime.signal.aborted) throw e;
          if (config.recovery === 'none')
            await runtime.commit(async (tx) => {
              (await tx.doc(RemoteIntents, runtime.conversationId)).operations[
                current.input.parentId
              ].status = 'unknown';
              return {
                status: 'terminal',
                outcome: {
                  status: 'completed',
                  result: { ok: false, code: 'remote_outcome_unknown' },
                },
              };
            }, context);
          // Otherwise the committed recover-submit phase reconciles the original idempotency key.
        }
      },
      'recover-submit': async (current, runtime, context) => {
        const done = async (code: string) =>
          runtime.commit(async (tx) => {
            (await tx.doc(RemoteIntents, runtime.conversationId)).operations[
              current.input.parentId
            ].status = code === 'remote_wait_timeout' ? 'timeout' : 'unknown';
            return {
              status: 'terminal',
              outcome: { status: 'completed', result: { ok: false, code } },
            };
          }, context);
        if (runtime.now() >= current.state.checkpoint.deadline) return done('remote_wait_timeout');
        if (config.recovery === 'none') return done('remote_outcome_unknown');
        if (runtime.now() < current.state.checkpoint.nextPollAt)
          await runtime.sleep(current.state.checkpoint.nextPollAt, context);
        if (runtime.now() >= current.state.checkpoint.deadline) return done('remote_wait_timeout');
        try {
          const response =
            config.recovery === 'key'
              ? await request(
                  '/requests',
                  'POST',
                  runtime.signal,
                  { prompt: current.input.prompt },
                  current.input.key,
                  current.input.deadline,
                )
              : await request(
                  '/requests?key=' + encodeURIComponent(current.input.key),
                  'GET',
                  runtime.signal,
                  undefined,
                  undefined,
                  current.input.deadline,
                );
          if (typeof response.id !== 'string' || !response.id || response.id.length > 512)
            return done('remote_outcome_unknown');
          await runtime.commit(async (tx) => {
            const operation = (await tx.doc(RemoteIntents, runtime.conversationId)).operations[
              current.input.parentId
            ];
            operation.remoteId = response.id as string;
            operation.status = 'waiting';
            operation.remoteStatus = 'pending';
            return {
              status: 'running',
              checkpoint: { ...current.state.checkpoint, phase: 'poll' },
            };
          }, context);
        } catch (e) {
          if (runtime.signal.aborted) throw e;
          const nextPollAt = Math.min(
            current.state.checkpoint.deadline,
            runtime.now() +
              intervals[Math.min(current.state.checkpoint.attempt, intervals.length - 1)],
          );
          await runtime.commit(async (tx) => {
            (await tx.doc(RemoteIntents, runtime.conversationId)).operations[
              current.input.parentId
            ].nextPollAt = nextPollAt;
            return {
              status: 'running',
              checkpoint: {
                ...current.state.checkpoint,
                nextPollAt,
                attempt: current.state.checkpoint.attempt + 1,
              },
            };
          }, context);
        }
      },
      poll: async (current, runtime, context) => {
        const state = current.state.checkpoint;
        if (runtime.now() < state.nextPollAt) await runtime.sleep(state.nextPollAt, context);
        if (runtime.now() >= state.deadline)
          return runtime.commit(async (tx) => {
            (await tx.doc(RemoteIntents, runtime.conversationId)).operations[
              current.input.parentId
            ].status = 'timeout';
            return {
              status: 'terminal',
              outcome: { status: 'completed', result: { ok: false, code: 'remote_wait_timeout' } },
            };
          }, context);
        let response: Record<string, Json> | undefined;
        const operation = (await runtime.snapshot(RemoteIntents, runtime.conversationId, context))
          ?.operations[current.input.parentId];
        try {
          response = await request(
            '/requests/' + encodeURIComponent(operation!.remoteId!),
            'GET',
            runtime.signal,
            undefined,
            undefined,
            current.input.deadline,
          );
        } catch (e) {
          if (runtime.signal.aborted) throw e;
        }
        await runtime.commit(async (tx) => {
          const intent = (await tx.doc(RemoteIntents, runtime.conversationId)).operations[
            current.input.parentId
          ];
          if (response?.status === 'completed' && response.result !== undefined) {
            intent.status = 'completed';
            intent.remoteStatus = 'completed';
            return {
              status: 'terminal',
              outcome: { status: 'completed', result: { ok: true, value: response.result } },
            };
          }
          if (response?.status === 'failed' || response?.status === 'canceled') {
            intent.status = 'failed';
            intent.remoteStatus = response.status;
            return {
              status: 'terminal',
              outcome: {
                status: 'completed',
                result: {
                  ok: false,
                  code: response.status === 'failed' ? 'remote_failed' : 'remote_canceled',
                },
              },
            };
          }
          const nextPollAt = Math.min(
            state.deadline,
            runtime.now() + intervals[Math.min(state.attempt, intervals.length - 1)],
          );
          intent.status = 'waiting';
          intent.remoteStatus = response ? 'pending' : 'unavailable';
          intent.nextPollAt = nextPollAt;
          return {
            status: 'running',
            checkpoint: { ...state, nextPollAt, attempt: state.attempt + 1 },
          };
        }, context);
      },
    },
    abort: async (current, runtime, context) => {
      const operation = (await runtime.snapshot(RemoteIntents, runtime.conversationId, context))
        ?.operations[current.input.parentId];
      let status = operation?.status === 'prepared' ? 'canceled' : 'cancel_unknown';
      let remoteStatus = operation?.remoteStatus ?? 'unknown';
      if (operation?.remoteId) {
        try {
          const result = await request(
            '/requests/' + encodeURIComponent(operation.remoteId),
            'DELETE',
            runtime.signal,
          );
          if (result.status === 'canceled') {
            status = 'canceled';
            remoteStatus = 'canceled';
          } else if (result.status === 'completed') {
            status = 'cancel_failed';
            remoteStatus = 'completed';
          }
        } catch (e) {
          if (runtime.signal.aborted) throw e;
          status =
            e instanceof AppError && e.code === 'remote_cancel_unsupported'
              ? 'cancel_unsupported'
              : 'cancel_failed';
        }
      }
      await runtime.commit(async (tx) => {
        const intent = (await tx.doc(RemoteIntents, runtime.conversationId)).operations[
          current.input.parentId
        ];
        intent.status = status;
        intent.remoteStatus = remoteStatus;
        return {
          status: 'terminal',
          outcome: { status: 'aborted', result: { ok: false, code: 'remote_' + status } },
        };
      }, context);
    },
  });
  return {
    name: 'remote-example',
    tasks: [task],
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api, context) => {
          if (call.name !== 'example_generate') return;
          const operations =
            (await api.snapshot(RemoteIntents, api.conversationId, context))?.operations ?? {};
          if (Object.values(operations).some(remoteBlocked))
            return { block: 'remote_outcome_unknown: use an explicit retry or recheck action' };
        },
      }),
    ],
    tools: [
      defineTool({
        name: 'example_generate',
        description:
          'Run the configured asynchronous example service and wait for its final JSON result.',
        parameters: Type.Object({ prompt: Type.String({ minLength: 1, maxLength: 32000 }) }),
        replay: 'safe',
        execute: async ({ prompt }, api, context) => {
          const runId = await host.runId();
          const fingerprint = Array.from(
            new Uint8Array(
              await crypto.subtle.digest(
                'SHA-256',
                new TextEncoder().encode(canonicalJson({ prompt })),
              ),
            ),
          )
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
          const id = await api.commit(async (tx) => {
            const doc = await tx.doc(RemoteIntents, api.conversationId);
            const existing = doc.operations[api.taskId];
            if (existing) return existing.childTaskId as TaskId<Result>;
            if (Object.values(doc.operations).some(remoteBlocked))
              throw new AppError(409, 'remote_outcome_unknown');
            const deadline = Date.now() + (config.waitMs ?? 600000),
              key = host.identity + ':' + api.taskId;
            const child = await tx.createTask(
              task,
              { prompt, parentId: Number(api.taskId), key, deadline },
              { ownership: { kind: 'task', taskId: api.taskId } },
            );
            doc.operations[api.taskId] = {
              taskId: Number(api.taskId),
              childTaskId: Number(child),
              runId,
              callId: api.callId,
              service: 'example',
              toolName: 'example_generate',
              fingerprint,
              key,
              remoteId: null,
              status: 'prepared',
              remoteStatus: 'unknown',
              deadline,
              nextPollAt: 0,
              retryRunId: null,
              retryTaskId: null,
            };
            return child;
          }, context);
          const settled = await api.waitForTask(id, context);
          const result = settled.state.outcome.result;
          return {
            isError: !result?.ok,
            content: [
              { type: 'text', text: jsonText(result ?? { ok: false, code: 'remote_task_failed' }) },
            ],
            details: { remoteTaskId: Number(api.taskId) },
          };
        },
      }),
    ],
  };
}
