import {
  defineTask,
  type Cursor,
  type Storage,
  type Task,
  type Tx,
} from '@earendil-works/pi-durable';
import { connectionKey, operationId } from './configuration';

type Scope = { kind: 'deployment' | 'user'; ownerId: string };
type Input = { scope: Scope['kind']; ownerId: string; target: string; operation: string };
/** Immutable current-format connection identity survives closing the caller before its result commit. */
export type McpDispatchIdentity = Omit<Input, 'operation'> & { chatId: string };
type Checkpoint = { phase: 'acknowledge'; attempt: number; retryAt: number };
type Result = { acknowledged: boolean };
export const DEPLOYMENT_MCP_ACKNOWLEDGEMENT = 'app.deployment-mcp-acknowledgement';
export const USER_MCP_ACKNOWLEDGEMENT = 'app.mcp-acknowledgement';

function connection(env: Env, input: Input) {
  return env.MCP_CONNECTIONS.getByName(
    connectionKey(
      input.scope === 'deployment'
        ? {
            kind: 'deployment',
            ownerId: input.ownerId,
            serverId: input.target,
            configurationRevision: '',
          }
        : { kind: 'user', ownerId: input.ownerId, connectionId: input.target },
    ),
  );
}
async function acknowledge(env: Env, input: Input) {
  const stub = connection(env, input);
  if (input.scope === 'deployment')
    await stub.deploymentAcknowledge(input.ownerId, input.target, input.operation);
  else await stub.acknowledge(input.ownerId, input.operation);
}

async function reconcileDispatch(env: Env, input: Input) {
  const stub = connection(env, input);
  // This cancels a still-running intent or reads an already-known result. It never dispatches remotely.
  const result =
    input.scope === 'deployment'
      ? await stub.deploymentCancel(input.ownerId, input.target, input.operation)
      : await stub.cancel(input.ownerId, input.operation);
  if (result.result) await acknowledge(env, input);
}

/** After closing the Harness, deletion confirms known effects without starting model/tool execution. */
export async function drainMcpAcknowledgements(
  storage: Storage,
  env: Env,
  context: Parameters<Storage['scanTasks']>[3],
): Promise<void> {
  for (const [kind, scope] of [
    ['app.deployment-mcp-call', 'deployment'],
    ['app.mcp-call', 'user'],
  ] as const) {
    let cursor: Cursor | undefined;
    do {
      const page = await storage.scanTasks({ kind }, 64, cursor, context);
      for (const record of page.items) {
        const identity = (record.input as { dispatch?: McpDispatchIdentity } | undefined)?.dispatch;
        if (
          record.version !== 1 ||
          !identity ||
          identity.scope !== scope ||
          typeof identity.ownerId !== 'string' ||
          !identity.ownerId ||
          typeof identity.target !== 'string' ||
          !identity.target ||
          typeof identity.chatId !== 'string' ||
          !identity.chatId
        )
          throw new Error('Invalid durable MCP dispatch identity');
        // A response may have reached the connection DO but not this caller before close.
        // Check every call receipt, including terminal unknown/aborted callers, before erasing it.
        await reconcileDispatch(env, {
          scope,
          ownerId: identity.ownerId,
          target: identity.target,
          operation: operationId(identity.chatId, record.conversationId, Number(record.id)),
        });
      }
      cursor = page.next;
    } while (cursor);
  }
  for (const kind of [DEPLOYMENT_MCP_ACKNOWLEDGEMENT, USER_MCP_ACKNOWLEDGEMENT]) {
    for (const status of ['pending', 'running', 'waiting', 'completing'] as const) {
      let cursor: Cursor | undefined;
      do {
        const page = await storage.scanTasks({ kind, status }, 64, cursor, context);
        for (const record of page.items) {
          const input = record.input as Input;
          if (
            record.version !== 1 ||
            !input ||
            typeof input !== 'object' ||
            input.scope !== (kind === DEPLOYMENT_MCP_ACKNOWLEDGEMENT ? 'deployment' : 'user') ||
            typeof input.ownerId !== 'string' ||
            !input.ownerId ||
            typeof input.target !== 'string' ||
            !input.target ||
            typeof input.operation !== 'string' ||
            !input.operation
          )
            throw new Error('Invalid durable MCP acknowledgement');
          // A failure leaves the native record and delete intent intact for the next alarm.
          await acknowledge(env, input);
        }
        cursor = page.next;
      } while (cursor);
    }
  }
}

function acknowledgementTask(env: Env, name: string) {
  const enqueue = (tx: Tx, input: Input) =>
    tx.createTask(task, input, {
      ownership: { kind: 'conversation' },
      background: true,
      abandonOnRestart: false,
    });
  const task: Task<Input, Checkpoint, Result, object> = defineTask<Input, Checkpoint, Result>({
    name,
    version: 1,
    initial: () => ({ phase: 'acknowledge', attempt: 0, retryAt: 0 }),
    phases: {
      acknowledge: async (current, runtime, context) => {
        await runtime.sleep(current.state.checkpoint.retryAt, context);
        let interrupted!: () => void;
        const cancellation = new Promise<never>((_resolve, reject) => {
          interrupted = () => reject(runtime.signal.reason);
          if (runtime.signal.aborted) interrupted();
          else runtime.signal.addEventListener('abort', interrupted, { once: true });
        });
        try {
          // This RPC is idempotent, including when its previous response was lost.
          // Stop/close cancels the wait; a late delivery can safely race the durable successor.
          await Promise.race([acknowledge(env, current.input), cancellation]);
        } catch {
          runtime.signal.throwIfAborted();
          const attempt = current.state.checkpoint.attempt + 1;
          await runtime.commit(
            () => ({
              status: 'running',
              checkpoint: {
                phase: 'acknowledge',
                attempt,
                retryAt: runtime.now() + Math.min(60_000, 1000 * 2 ** Math.min(attempt - 1, 6)),
              },
            }),
            context,
          );
          return;
        } finally {
          runtime.signal.removeEventListener('abort', interrupted);
        }
        await runtime.commit(
          () => ({
            status: 'terminal',
            outcome: { status: 'completed', result: { acknowledged: true } },
          }),
          context,
        );
      },
    },
    abort: async (current, runtime, context) => {
      // Stop may cancel execution, but cannot undo a result already committed to Pi.
      // Transfer only the confirmation obligation across the background abort boundary.
      await runtime.commit(async (tx) => {
        await enqueue(tx, current.input);
        return {
          status: 'terminal',
          outcome: { status: 'completed', result: { acknowledged: false } },
        };
      }, context);
    },
  });
  return { task, enqueue };
}

/** Host definitions remain installed when tool exposure/configuration is disabled. */
export function mcpAcknowledgementTasks(env: Env) {
  return [DEPLOYMENT_MCP_ACKNOWLEDGEMENT, USER_MCP_ACKNOWLEDGEMENT].map(
    (name) => acknowledgementTask(env, name).task,
  );
}

/** The durable result and its confirmation obligation are written in one native commit. */
export function mcpAcknowledgements(env: Env, scope: Scope) {
  const acknowledgement = acknowledgementTask(
    env,
    scope.kind === 'deployment' ? DEPLOYMENT_MCP_ACKNOWLEDGEMENT : USER_MCP_ACKNOWLEDGEMENT,
  );
  return {
    task: acknowledgement.task,
    enqueue: (tx: Tx, input: Pick<Input, 'target' | 'operation'>) =>
      acknowledgement.enqueue(tx, { ...input, scope: scope.kind, ownerId: scope.ownerId }),
  };
}
