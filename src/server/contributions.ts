import type {
  EntryRecord,
  Extension,
  TaskRecord,
  SubmissionRecord,
  Harness,
  ConversationDocToken,
  JsonObject,
  TaskId,
  Conversation,
} from '@earendil-works/pi-durable';
import type { Json as JsonValue } from '../shared/json';
import { AppError, type StoredCommand } from '../shared/contracts';
import { validateExtensions } from './extensions';
import type { successfulTool } from '../shared/references';

/** Trusted deployment code. Read contexts do not expose execution, credentials or writes. */
export type ReadContext = {
  entries: () => Promise<readonly EntryRecord[]>;
  successfulTool: (ref: string, name: string) => Promise<ReturnType<typeof successfulTool>>;
  acceptedInput: (entryId: number) => Promise<
    | {
        text: string;
        source?: StoredCommand['source'];
        context?: JsonValue;
      }
    | undefined
  >;
};
/** Committed native facts, never a second execution runtime or a writable Pi handle. */
export type ProjectionContext = {
  entries: readonly EntryRecord[];
  tasks: readonly TaskRecord<JsonValue, JsonValue, JsonValue>[];
  submissions: readonly SubmissionRecord[];
  documents?: ReadonlyMap<string, Readonly<JsonObject> | null>;
};
/** Trusted execution hooks use Pi itself; they must not introduce another queue or task store. */
export type ExecutionContext = {
  pi: Harness;
  context: Parameters<Harness['inspect']>[0];
  command?: StoredCommand;
  entries: readonly EntryRecord[];
};
export type ContributionHost = {
  identity: string;
  conversationId?: string;
  pi: () => Promise<Harness>;
  command: () => Promise<StoredCommand | undefined>;
};
export type ServerContribution = {
  id: string;
  extension?: Extension;
  execution?: {
    /** Runs at the model boundary. A rejection fails closed before a provider call. */
    beforeModel?: (context: ExecutionContext) => Promise<void>;
    /** Runs only for a new admission while Pi has no pending inputs. */
    beforeSubmit?: (context: ExecutionContext) => Promise<void>;
    /** Called after the host aborts an incompatible native task during recovery. */
    taskUnavailable?: (context: ExecutionContext & { taskId: TaskId }) => Promise<void>;
  };
  /** Only these native conversation documents enter the private projection fold. */
  stateDocuments?: readonly ConversationDocToken<JsonObject>[];
  resources?: {
    read(ref: string, context: ReadContext): Promise<{ data: JsonValue; initialState: JsonValue }>;
    validateState?(state: unknown): JsonValue;
  };
  /** Out-of-band decisions for existing native work; never enqueue a new model run. */
  controls?: Record<
    string,
    {
      invoke(
        payload: JsonValue,
        context: { conversation: Conversation; context: ExecutionContext['context'] },
      ): Promise<JsonValue>;
    }
  >;
  actions?: Record<
    string,
    { normalize(payload: JsonValue, context: ReadContext): Promise<JsonValue> }
  >;
  projectTool?: (value: {
    toolName: string;
    output?: string;
    details?: JsonValue;
    terminal: boolean;
  }) => JsonValue;
  projectState?: (context: ProjectionContext) => JsonValue;
};
export function validateContributionIds(ids: readonly string[]) {
  const seen = new Set<string>();
  for (const id of ids) {
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(id))
      throw new AppError(503, 'invalid_extension_id');
    if (seen.has(id)) throw new AppError(503, 'duplicate_extension_id', 'duplicate extension ID');
    seen.add(id);
  }
}
export function collectContributions(contributions: readonly ServerContribution[]) {
  validateContributionIds(contributions.map((contribution) => contribution.id));
  for (const contribution of contributions) {
    if (
      (contribution.resources &&
        (typeof contribution.resources.read !== 'function' ||
          (contribution.resources.validateState !== undefined &&
            typeof contribution.resources.validateState !== 'function'))) ||
      (contribution.projectTool !== undefined && typeof contribution.projectTool !== 'function') ||
      (contribution.projectState !== undefined &&
        typeof contribution.projectState !== 'function') ||
      Object.values(contribution.execution ?? {}).some(
        (handler) => typeof handler !== 'function',
      ) ||
      Object.entries(contribution.controls ?? {}).some(
        ([name, control]) =>
          !/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(name) || typeof control?.invoke !== 'function',
      ) ||
      Object.entries(contribution.actions ?? {}).some(
        ([name, action]) =>
          !/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(name) || typeof action?.normalize !== 'function',
      )
    )
      throw new AppError(503, 'invalid_extension_handler');
  }
  validateExtensions(
    contributions.flatMap((contribution) =>
      contribution.extension ? [contribution.extension] : [],
    ),
  );
  return contributions;
}
