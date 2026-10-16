import { ROOT_CONVERSATION_ID, type TaskId, type TaskRecord } from '@earendil-works/pi-durable';
import { AppError } from '../../shared/contracts';
import type {
  ContributionHost,
  ExecutionContext,
  ServerContribution,
} from '../../server/extensions/contributions';
import { ASYNC_EXAMPLE_ID, remoteActionPayload, remoteSource } from './contracts';
import { RemoteIntents, type RemoteIntent } from './intents';
import { remoteProgress } from './progress';
import {
  remoteBlocked,
  remoteModelAllowed,
  remoteRunBlocked,
  remoteExample,
  type RemoteConfig,
} from './runtime';

const interrupted = (
  operation: RemoteIntent,
  task?: Pick<TaskRecord<unknown, unknown, unknown>, 'state'>,
) =>
  ['prepared', 'submitting', 'waiting'].includes(operation.status) &&
  (!task || task.state.status === 'terminal');

/** A disabled extension can leave a native task aborted without its provider-specific abort handler. */
async function reconcileInterrupted(
  pi: ExecutionContext['pi'],
  context: ExecutionContext['context'],
) {
  const saved = await pi.snapshot(RemoteIntents, ROOT_CONVERSATION_ID, context);
  if (!saved) return;
  const stale: RemoteIntent[] = [];
  for (const operation of Object.values(saved.operations))
    if (
      ['prepared', 'submitting', 'waiting'].includes(operation.status) &&
      interrupted(operation, await pi.getTask(operation.childTaskId as TaskId, context))
    )
      stale.push(operation);
  if (!stale.length) return saved;
  await pi.commit(async (tx) => {
    const doc = await tx.doc(RemoteIntents, ROOT_CONVERSATION_ID);
    for (const operation of stale) {
      const current = doc.operations[operation.taskId];
      if (current && interrupted(current, await tx.task(current.childTaskId as TaskId)))
        current.status = 'unknown';
    }
  }, context);
  return pi.snapshot(RemoteIntents, ROOT_CONVERSATION_ID, context);
}

/** Example provider, authorization, recovery and public state share one removable contribution. */
export function asyncExampleContribution(
  config?: RemoteConfig,
  host?: ContributionHost,
): ServerContribution {
  if (config && !host) throw new AppError(503, 'extension_execution_host_missing');
  const action = (name: 'retry' | 'recheck') => ({
    async normalize(
      payload: Parameters<NonNullable<ServerContribution['actions']>[string]['normalize']>[0],
    ) {
      const parsed = remoteActionPayload.safeParse(payload);
      if (!parsed.success) throw new AppError(400, 'invalid_action_payload');
      if (!host) throw new AppError(503, 'remote_disabled');
      const pi = await host.pi();
      const original = (await reconcileInterrupted(pi, background))?.operations[parsed.data.taskId];
      if (!original) throw new AppError(404, 'remote_reference_not_found');
      if (!config)
        throw new AppError(503, 'remote_disabled', '远端能力当前不可用，请联系应用维护者。');
      if (original.service !== config.endpoint)
        throw new AppError(
          409,
          'remote_configuration_changed',
          '远端服务配置已更改，请联系应用维护者。',
        );
      if (name === 'retry' && !remoteBlocked(original))
        throw new AppError(409, 'remote_retry_unnecessary');
      return {
        action: name === 'retry' ? 'retry_remote' : 'recheck_remote',
        taskId: parsed.data.taskId,
      };
    },
  });
  return {
    id: ASYNC_EXAMPLE_ID,
    ...(config && host
      ? {
          extension: remoteExample(config, {
            identity: host.identity,
            command: async () => {
              const command = await host.command();
              if (!command) throw new AppError(409, 'run_context_missing');
              return command;
            },
          }),
        }
      : {}),
    actions: { retry: action('retry'), recheck: action('recheck') },
    stateDocuments: [RemoteIntents],
    historyScope: 'none',
    taskReferences: (documents) =>
      Object.values(
        (documents.get(RemoteIntents.definition.kind)?.operations ?? {}) as Record<
          string,
          RemoteIntent
        >,
      ).map((operation) => operation.childTaskId),
    projectState: ({ documents, tasks }) => {
      const records = new Map(tasks.map((task) => [Number(task.id), task]));
      const operations = (documents?.get(RemoteIntents.definition.kind)?.operations ??
        {}) as Record<string, RemoteIntent>;
      return remoteProgress(
        Object.fromEntries(
          Object.entries(operations).map(([id, operation]) => [
            id,
            interrupted(operation, records.get(operation.childTaskId))
              ? { ...operation, status: 'unknown' }
              : operation,
          ]),
        ),
      );
    },
    execution: {
      async beforeModel({ pi, context, command, entries }) {
        const doc = await reconcileInterrupted(pi, context);
        if (!remoteModelAllowed(doc?.operations ?? {}, command) || remoteRunBlocked(entries))
          throw new AppError(409, 'remote_outcome_unknown');
      },
      async beforeSubmit({ pi, context, command, entries }) {
        const saved = await reconcileInterrupted(pi, context);
        if (!saved) return;
        const referenced = remoteSource(command?.source)?.taskId;
        const published = new Set(
          entries
            .flatMap((entry) => entry.model ?? [])
            .flatMap((message) =>
              message.role === 'toolResult' &&
              !message.isError &&
              message.details &&
              typeof message.details === 'object' &&
              'remoteTaskId' in message.details
                ? [message.details.remoteTaskId]
                : [],
            ),
        );
        const completed = Object.values(saved.operations).filter(
          (operation) =>
            operation.status === 'completed' &&
            published.has(operation.taskId) &&
            operation.taskId !== referenced,
        );
        if (completed.length)
          await pi.commit(async (tx) => {
            const doc = await tx.doc(RemoteIntents, ROOT_CONVERSATION_ID);
            for (const operation of completed)
              if (doc.operations[operation.taskId]?.status === 'completed')
                delete doc.operations[operation.taskId];
          }, context);
      },
      async taskUnavailable({ pi, context, taskId }) {
        if (!(await pi.snapshot(RemoteIntents, ROOT_CONVERSATION_ID, context))) return;
        await pi.commit(async (tx) => {
          for (const operation of Object.values(
            (await tx.doc(RemoteIntents, ROOT_CONVERSATION_ID)).operations,
          ))
            if (operation.childTaskId === Number(taskId)) operation.status = 'unknown';
        }, context);
      },
    },
  };
}

// A connector action runs outside a native task; use the same unbounded host context.
const background: Parameters<import('@earendil-works/pi-durable').Harness['inspect']>[0] =
  Object.freeze({
    abortSignal: undefined,
    value: () => undefined,
    toString: () => '[Async example action]',
  });
