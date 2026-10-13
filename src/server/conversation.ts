import { Agent } from 'agents';
import { LifecycleCapability } from 'agents/lifecycle';
import { PiHarness } from 'agents/harness/pi';
import {
  Harness,
  ROOT_CONVERSATION_ID,
  createRegistry,
  createSession,
  watchEvents,
  type Cursor,
  type Extension,
  type EntryRecord,
  type TaskId,
} from '@earendil-works/pi-durable';
import type { Models } from '@earendil-works/pi-ai/models';
import {
  AppError,
  commandSchema,
  USER_ACTION_CONTEXT,
  type RunCommand,
  storedRequestSchema,
  type StoredRequest,
} from '../shared/contracts';
import { jsonText, canonicalJson } from '../shared/compute';
import { applicationContributions } from './assembly';
import type { ServerContribution, ReadContext } from './contributions';
import { readSuccessfulTool } from './history';
import {
  MCPBindings,
  buildMcp,
  configureMcpStartup,
  mcpConfiguration,
  type MCPConfig,
} from './mcp';
import {
  RemoteIntents,
  remoteBlocked,
  remoteModelAllowed,
  remoteRunBlocked,
  remoteExample,
  remoteConfiguration,
  type RemoteConfig,
} from './remote-example';
import { validateExtensions } from './extensions';
import { withRunLimits, runLimits, toolBudget } from './limits';
import { observeRun } from './observe';
import { browserEntries } from '../shared/stream';
import { restoreToolProgress, toolProjector } from './tool-progress';
import { createExtensionProjection } from './extension-state';
import { applicationModels, applicationModelCatalog, validateModelSelection } from './models';
import { ModelCredentials } from './model-credentials';
import {
  bindExecution,
  executionModels,
  restoreExecutionModels,
  type CredentialAccess,
} from './execution-models';
import type { ModelSelection } from '../shared/model-selection';
import { remoteProgress } from '../shared/remote-progress';
import { mcpIntentUnresolved } from './remote-intents';
import { claimPiStorage, validatePiStorage, RuntimeStorageError } from './pi-storage';
import { withdrawIdleInputs } from './queue-recovery';
export const BG: Parameters<Harness['close']>[0] = Object.freeze({
  abortSignal: undefined,
  value: () => undefined,
  toString: () => '[Application background]',
});
class RequestRecovery extends LifecycleCapability {
  constructor(private owner: ConversationAgent) {
    super('app-requests');
  }
  override async onStart() {
    if (this.owner.needsRecovery()) await this.schedule();
  }
  schedule() {
    return this.lifecycle.jobs.push({
      id: 'reconcile',
      fn: 'reconcile',
      time: Date.now(),
      singleflight: true,
      recoveryLoop: true,
    });
  }
  async onJob() {
    await this.owner.reconcile();
  }
}
export class ConversationAgent extends Agent<Env> {
  readonly harness: PiHarness;
  private runtimeModels?: ReturnType<typeof executionModels>;
  private admission: Promise<unknown> = Promise.resolve();
  private recovery: RequestRecovery;
  private stopWork?: Promise<void>;
  private deletionId?: string;
  private mcpPrepared?: Awaited<ReturnType<typeof buildMcp>>;
  private deleteWork?: Promise<void>;
  private contributionSet?: Promise<readonly ServerContribution[]>;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    configureMcpStartup(
      this.mcp,
      () => this.mcpConfiguration(),
      env as unknown as Record<string, unknown>,
    );
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS app_requests (id TEXT PRIMARY KEY,payload TEXT NOT NULL,accepted INTEGER NOT NULL DEFAULT 0)',
    );
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS app_inputs (ref TEXT PRIMARY KEY,state TEXT NOT NULL,revision INTEGER NOT NULL,updated INTEGER NOT NULL)',
    );
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)',
    );
    const deletion = ctx.storage.sql
      .exec('SELECT value FROM app_meta WHERE key=?', 'deleting')
      .toArray()[0]?.value;
    this.deletionId = typeof deletion === 'string' ? deletion : undefined;
    this.harness = new PiHarness({
      defaults: { model: { provider: env.MODEL_PROVIDER, id: env.MODEL_ID } },
      harness: async ({ storage: nativeStorage, context }) => {
        const runtime: { pi?: Harness; superseded: boolean } = { superseded: false };
        const storage = claimPiStorage(nativeStorage, ctx.storage, () => {
          runtime.superseded = true;
          void runtime.pi?.close(BG).catch(() => {
            console.error(JSON.stringify({ stage: 'pi', error: 'runtime_close_failed' }));
          });
        });
        // Materialize recovery documents before Harness.open/resume can schedule tasks.
        // Invalid persistence fails this conversation's startup instead of starving the worker.
        try {
          await validatePiStorage(storage);
        } catch (error) {
          console.error(
            JSON.stringify({
              stage: 'pi',
              error: 'runtime_storage_invalid',
              documentId: error instanceof RuntimeStorageError ? error.documentId : undefined,
            }),
          );
          throw error;
        }
        const registry = createRegistry();
        // A read-only bootstrap snapshot avoids calling the not-yet-open Harness from its factory.
        const saved = await createSession(storage).snapshot(
          MCPBindings,
          ROOT_CONVERSATION_ID,
          context,
        );
        const configs = this.mcpConfiguration();
        if (configs.length || saved?.bindings.length)
          this.mcpPrepared = await buildMcp(
            this.mcp,
            configs,
            this.env as unknown as Record<string, unknown>,
            saved?.bindings,
            async () => {
              const stored = await this.runningRequest();
              if (!stored) throw new AppError(409, 'mcp_run_context_missing');
              return stored.request;
            },
          );
        const extensions = await this.extensions();
        validateExtensions(extensions);
        for (const extension of extensions) registry.install(extension);
        const models = executionModels(this.models());
        await restoreExecutionModels(
          createSession(storage),
          models,
          this.rows<{ payload: string; accepted: number }>(
            'SELECT payload,accepted FROM app_requests WHERE accepted<>-1',
          ).map((record) => ({
            stored: storedRequestSchema.parse(JSON.parse(record.payload)),
            accepted: record.accepted,
          })),
          () => this.credentials(),
          context,
        );
        this.runtimeModels = models;
        const pi = await Harness.open(
          storage,
          {
            models: withRunLimits(
              models,
              () => this.allEntries(),
              (entries) => this.assertModelAllowed(entries),
              toolBudget(this.env as unknown as Record<string, unknown>),
            ),
            registry,
            settings: {
              followUpMode: 'one-at-a-time',
              steeringMode: 'one-at-a-time',
              toolExecution: 'sequential',
            },
            conversationCreated: async (tx, conversation) => {
              if (this.mcpPrepared?.bindings.length && conversation.id === ROOT_CONVERSATION_ID)
                (await tx.doc(MCPBindings, conversation.id)).bindings = this.mcpPrepared.bindings;
            },
            onReport: (error) =>
              console.error(
                JSON.stringify({
                  stage: 'pi',
                  error: error instanceof RuntimeStorageError ? error.code : 'runtime_report',
                  name: error instanceof Error ? error.name.slice(0, 64) : typeof error,
                }),
              ),
          },
          context,
        );
        runtime.pi = pi;
        if (runtime.superseded) {
          await pi.close(BG);
          throw new RuntimeStorageError('runtime_superseded');
        }
        const unsubscribe = pi.subscribeCommits(({ changes }) => {
          if (
            changes.some(
              (change) =>
                change.type === 'submission' &&
                change.value.conversationId === ROOT_CONVERSATION_ID &&
                change.value.status === 'unanswered' &&
                ['model_error', 'no_model', 'faulted', 'orphaned'].includes(change.value.reason),
            )
          )
            queueMicrotask(() => {
              if (!this.deleting && !this.stopping && !runtime.superseded)
                this.ctx.waitUntil(this.recovery.schedule());
            });
        });
        pi.subscribeClose(unsubscribe);
        await withdrawIdleInputs(pi, context);
        const existing = await pi.conversation(ROOT_CONVERSATION_ID, context);
        if (existing && this.mcpPrepared?.bindings.length)
          await existing.commit(async (tx) => {
            (await tx.doc(MCPBindings, existing.id)).bindings = this.mcpPrepared!.bindings;
          }, context);
        // Native Pi leaves incompatible definitions blocked. Settle them explicitly on deployment
        // recovery so unsupported work cannot hold the conversation in a permanent running state.
        for (const task of (await pi.inspect(context)).tasks)
          if (task.state.kind === 'blocked') {
            await pi.abortTask(task.record.id, context);
            if (await pi.snapshot(RemoteIntents, ROOT_CONVERSATION_ID, context))
              await pi.commit(async (tx) => {
                for (const operation of Object.values(
                  (await tx.doc(RemoteIntents, ROOT_CONVERSATION_ID)).operations,
                ))
                  if (operation.childTaskId === Number(task.record.id))
                    operation.status = 'unknown';
              }, context);
          }
        return pi;
      },
    });
    this.recovery = new RequestRecovery(this);
    this.lifecycle.use(this.harness).use(this.recovery);
  }
  protected models(): Models {
    return applicationModels(this.env);
  }
  protected async credentials(): Promise<CredentialAccess> {
    const owner = await this.env.DB.prepare('SELECT owner FROM conversations WHERE id=?')
      .bind(this.name)
      .first<string>('owner');
    if (!owner) throw new AppError(404, 'not_found');
    return new ModelCredentials(this.env, owner);
  }
  private modelCatalog() {
    return applicationModelCatalog(
      this.env as Env & { MODEL_IDS?: string; MODEL_THINKING_LEVEL?: string },
      this.models(),
    );
  }
  private selection(config?: ModelSelection) {
    return validateModelSelection(
      this.env as Env & { MODEL_IDS?: string; MODEL_THINKING_LEVEL?: string },
      this.models(),
      config,
    );
  }
  private async runningRequest() {
    // Pi owns the queue. Resolve the currently running operation, never the newest queued request.
    const running = (await this.harness.pending({ session: '1' })).find(
      (p) => p.status === 'running',
    );
    const row =
      running &&
      this.rows<{ payload: string }>(
        'SELECT payload FROM app_requests WHERE id=?',
        running.operationId,
      )[0];
    const stored = row ? storedRequestSchema.parse(JSON.parse(row.payload)) : undefined;
    return stored;
  }
  private async assertModelAllowed(entries: readonly EntryRecord[]) {
    const stored = await this.runningRequest();
    const pi = await this.harness.pi();
    const doc = await pi.snapshot(RemoteIntents, ROOT_CONVERSATION_ID, BG);
    if (!remoteModelAllowed(doc?.operations ?? {}, stored?.request) || remoteRunBlocked(entries))
      throw new AppError(409, 'remote_outcome_unknown');
    const current = entries.slice(entries.findLastIndex((entry) => entry.kind === 'pi.user'));
    const attempted = current
      .flatMap((entry) => entry.model ?? [])
      .flatMap((message) =>
        message.role === 'assistant'
          ? message.content.filter((part) => part.type === 'toolCall').map((part) => part.name)
          : [],
      );
    for (const intent of Object.values(doc?.mcp ?? {}))
      if (
        (!stored ||
          intent.runId === stored.request.runId ||
          this.mcpPrepared?.bindings.some(
            (binding) =>
              binding.replay === 'unsafe' &&
              attempted.includes(binding.name) &&
              (binding.serverId === intent.serverId || binding.endpoint === intent.endpoint),
          )) &&
        mcpIntentUnresolved(intent, await pi.getTask(intent.taskId as TaskId, BG))
      )
        throw new AppError(409, 'remote_outcome_unknown');
  }
  protected mcpConfiguration(): MCPConfig[] {
    return mcpConfiguration(this.env as unknown as Record<string, unknown>);
  }
  protected remoteConfiguration(): RemoteConfig | undefined {
    return remoteConfiguration(this.env as unknown as Record<string, unknown>);
  }
  protected contributions(): Promise<readonly ServerContribution[]> {
    return (this.contributionSet ??= applicationContributions(this.env, () => this.allEntries()));
  }
  protected async extensions(): Promise<Extension[]> {
    const remote = this.remoteConfiguration();
    return [
      runLimits(
        () => this.allEntries(),
        toolBudget(this.env as unknown as Record<string, unknown>),
      ),
      ...(await this.contributions()).flatMap((contribution) =>
        contribution.extension ? [contribution.extension] : [],
      ),
      ...(this.mcpPrepared ? [this.mcpPrepared.extension] : []),
      ...(remote
        ? [
            remoteExample(remote, {
              identity: this.ctx.id.toString(),
              command: async () => {
                const command = await this.runningRequest();
                if (!command) throw new AppError(409, 'run_context_missing');
                return command.request;
              },
            }),
          ]
        : []),
    ];
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.admission.then(fn);
    this.admission = next.catch(() => {});
    return next;
  }
  private rows<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...args: SqlStorageValue[]
  ) {
    return this.ctx.storage.sql.exec<T>(query, ...args).toArray();
  }
  get stopping() {
    return this.rows('SELECT value FROM app_meta WHERE key=?', 'stopping')[0]?.value === '1';
  }
  get deleting() {
    return this.deletionId !== undefined;
  }
  needsRecovery() {
    return (
      this.deleting ||
      this.stopping ||
      this.rows('SELECT id FROM app_requests WHERE accepted=0 LIMIT 1').length > 0
    );
  }
  private setStopping(value: boolean) {
    this.ctx.storage.sql.exec(
      'INSERT INTO app_meta(key,value)VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      'stopping',
      value ? '1' : '0',
    );
  }
  async root() {
    if (this.deleting) throw new AppError(404, 'not_found');
    const pi = await this.harness.pi();
    if (this.deleting) throw new AppError(404, 'not_found');
    const selection = this.modelCatalog().defaultSelection;
    return pi.root(BG, {
      agent: {
        model: { provider: selection.provider, modelId: selection.modelId },
        thinkingLevel: selection.thinkingLevel,
      },
    });
  }
  async submission(runId: string) {
    const root = await this.root();
    return root.commit((tx) => tx.submissionByRequest(root.id, runId), BG);
  }
  async submitRun(raw: RunCommand) {
    try {
      return await this.admit(raw);
    } catch (error) {
      if (error instanceof AppError)
        return { error: { status: error.status, code: error.code, message: error.message } };
      throw error;
    }
  }
  private async admit(raw: RunCommand) {
    const parsed = commandSchema.safeParse(raw);
    if (!parsed.success) throw new AppError(400, 'invalid_request');
    const command = parsed.data;
    const payload = canonicalJson(command);
    return this.serial(async () => {
      if (this.deleting) throw new AppError(404, 'not_found');
      if (this.stopping) throw new AppError(409, 'stopping');
      const record = this.rows<{ payload: string; accepted: number }>(
        'SELECT payload,accepted FROM app_requests WHERE id=?',
        command.runId,
      )[0];
      if (
        record &&
        canonicalJson(storedRequestSchema.parse(JSON.parse(record.payload)).request) !== payload
      )
        throw new AppError(409, 'request_conflict');
      if (record?.accepted === -1) throw new AppError(409, 'request_withdrawn');
      let stored = record ? storedRequestSchema.parse(JSON.parse(record.payload)) : undefined;
      if (!stored) {
        await this.root();
        await withdrawIdleInputs(await this.harness.pi(), BG);
        let sourceContext;
        if (command.source) {
          if (command.source.action === 'extension_action') {
            const source = command.source;
            const action = (await this.contributions()).find(
              (contribution) => contribution.id === source.extensionId,
            )?.actions;
            if (!action || !Object.hasOwn(action, source.name))
              throw new AppError(404, 'extension_action_unavailable');
            sourceContext = await action[source.name]!.normalize(
              structuredClone(source.payload),
              this.readContext(),
            );
            try {
              jsonText(sourceContext);
            } catch {
              throw new AppError(400, 'invalid_action_context');
            }
          } else {
            const doc = await (
              await this.harness.pi()
            ).snapshot(RemoteIntents, ROOT_CONVERSATION_ID, BG);
            const original = doc?.operations[command.source.taskId];
            if (!original) throw new AppError(404, 'remote_reference_not_found');
            if (!this.remoteConfiguration())
              throw new AppError(503, 'remote_disabled', '远端能力当前不可用，请联系应用维护者。');
            if (original.service !== this.remoteConfiguration()?.endpoint)
              throw new AppError(
                409,
                'remote_configuration_changed',
                '远端服务配置已更改，请联系应用维护者。',
              );
            if (command.source.action === 'retry_remote' && !remoteBlocked(original))
              throw new AppError(409, 'remote_retry_unnecessary');
          }
        }
        // Freeze provider as well as the UI choice, including the host/Pi acceptance gap.
        const selection = this.selection(command.config);
        const execution = {
          ...selection,
          credentialRef: await (await this.credentials()).select(selection.provider),
        };
        const pending = await this.harness.pending({ session: '1' });
        if (!pending.length) await this.pruneCompletedRemote(command);
        if (pending.filter((p) => p.status === 'queued').length >= 10)
          throw new AppError(429, 'queue_full');
        this.ctx.storage.sql.exec(
          'INSERT INTO app_requests(id,payload)VALUES(?,?)',
          command.runId,
          jsonText(
            (stored = {
              request: command,
              execution,
              ...(sourceContext === undefined ? {} : { sourceContext }),
            }),
            2 * 1048576 + 65536,
          ),
        );
      }
      if (!record?.accepted) {
        await this.recovery.schedule();
        await this.enqueue(stored!);
      }
      return { runId: command.runId, accepted: true as const };
    });
  }
  private async pruneCompletedRemote(command: RunCommand) {
    const pi = await this.harness.pi();
    const saved = await pi.snapshot(RemoteIntents, ROOT_CONVERSATION_ID, BG);
    if (!saved) return;
    const referenced =
      command.source &&
      (command.source.action === 'retry_remote' || command.source.action === 'recheck_remote')
        ? command.source.taskId
        : undefined;
    const published = new Set(
      (await this.allEntries())
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
      (o) => o.status === 'completed' && published.has(o.taskId) && o.taskId !== referenced,
    );
    const completedMcp: number[] = [];
    for (const intent of Object.values(saved.mcp ?? {}))
      if (!mcpIntentUnresolved(intent, await pi.getTask(intent.taskId as TaskId, BG)))
        completedMcp.push(intent.taskId);
    if (completed.length || completedMcp.length)
      await pi.commit(async (tx) => {
        const doc = await tx.doc(RemoteIntents, ROOT_CONVERSATION_ID);
        for (const operation of completed)
          if (doc.operations[operation.taskId]?.status === 'completed')
            delete doc.operations[operation.taskId];
        for (const taskId of completedMcp) delete doc.mcp?.[taskId];
      }, BG);
  }
  private async enqueue(stored: StoredRequest) {
    const command = stored.request;
    const root = await this.root();
    // Native acceptance survives a lost host acknowledgement. Reconcile that receipt before
    // requiring credentials or submitting: terminal work must not depend on its former model.
    if (await root.commit((tx) => tx.submissionByRequest(root.id, command.runId), BG)) {
      this.ctx.storage.sql.exec('UPDATE app_requests SET accepted=1 WHERE id=?', command.runId);
      return;
    }
    let text = command.text;
    const context =
      stored.sourceContext !== undefined
        ? stored.sourceContext
        : command.source?.action !== 'extension_action'
          ? command.source
          : undefined;
    if (context !== undefined) text += USER_ACTION_CONTEXT + '\n' + JSON.stringify(context);
    const provider = await bindExecution(this.runtimeModels!, stored.execution, () =>
      this.credentials(),
    );
    await this.harness.submit(text, {
      session: '1',
      operationId: command.runId,
      whenBusy: 'followUp',
      execution: {
        model: { provider, modelId: stored.execution.modelId },
        thinkingLevel: stored.execution.thinkingLevel,
      },
    });
    this.ctx.storage.sql.exec('UPDATE app_requests SET accepted=1 WHERE id=?', command.runId);
  }
  async reconcile() {
    if (this.deleting) {
      await this.finishDelete();
      return;
    }
    if (this.stopping) {
      await this.finishStop();
      return;
    }
    await this.serial(async () => {
      if (this.deleting || this.stopping) return;
      await withdrawIdleInputs(await this.harness.pi(), BG);
      for (const record of this.rows<{ id: string; payload: string }>(
        'SELECT id,payload FROM app_requests WHERE accepted=0 ORDER BY rowid',
      )) {
        if (this.stopping) break;
        await this.enqueue(storedRequestSchema.parse(JSON.parse(record.payload)));
      }
    });
  }
  async stopConversation() {
    return this.serial(async () => {
      if (this.deleting) return { stopping: true as const };
      this.setStopping(true);
      await this.recovery.schedule();
      this.ctx.waitUntil(this.finishStop());
      return { stopping: true as const };
    });
  }
  async deleteConversation(id: string) {
    await this.serial(async () => {
      if (this.deletionId && this.deletionId !== id) throw new AppError(409, 'deletion_conflict');
      this.ctx.storage.sql.exec(
        'INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        'deleting',
        id,
      );
      this.deletionId = id;
      this.setStopping(true);
      await this.recovery.schedule();
    });
    await this.finishDelete();
  }
  private finishDelete(): Promise<void> {
    return (this.deleteWork ??= (async () => {
      // Wait for tools to settle before disposing Pi and erasing the DO database.
      await this.finishStop();
      await this.env.DB.prepare('DELETE FROM conversations WHERE id=?')
        .bind(this.deletionId!)
        .run();
      await this.destroy();
    })().finally(() => {
      this.deleteWork = undefined;
    }));
  }
  private finishStop(): Promise<void> {
    return (this.stopWork ??= (async () => {
      await this.harness.abort({ session: '1' });
      await this.serial(async () => {
        this.ctx.storage.sql.exec('UPDATE app_requests SET accepted=-1 WHERE accepted=0');
        this.setStopping(false);
      });
    })().finally(() => {
      this.stopWork = undefined;
    }));
  }
  private async resource(extensionId: string, ref: string) {
    if (this.deleting) throw new AppError(404, 'not_found');
    const handler = (await this.contributions()).find(
      (contribution) => contribution.id === extensionId,
    )?.resources;
    if (!handler) throw new AppError(404, 'resource_not_found');
    const value = await handler.read(ref, this.readContext());
    try {
      // Resource data may combine independently bounded content/program components.
      // Saved and initial state retain their separate 1 MiB budget.
      // JSON escaping can expand UI/code bytes sixfold; 3 MiB covers their existing budgets.
      jsonText(value.data, 3 * 1024 * 1024);
      jsonText(value.initialState);
    } catch {
      throw new AppError(503, 'invalid_resource');
    }
    return { handler, value, key: JSON.stringify([extensionId, ref]) };
  }
  async loadResource(extensionId: string, ref: string): Promise<string> {
    try {
      const { value, key } = await this.resource(extensionId, ref);
      const saved = this.rows<{ state: string; revision: number }>(
        'SELECT state,revision FROM app_inputs WHERE ref=?',
        key,
      )[0];
      return JSON.stringify({
        ref,
        data: value.data,
        state: saved ? JSON.parse(saved.state) : value.initialState,
        revision: saved?.revision ?? 0,
      });
    } catch (error) {
      if (error instanceof AppError)
        return JSON.stringify({ error: { status: error.status, code: error.code } });
      throw error;
    }
  }
  async saveResourceState(
    extensionId: string,
    ref: string,
    state: unknown,
    expectedRevision: number,
  ): Promise<{ revision: number } | { error: { status: number; code: string } }> {
    try {
      return await this.writeResourceState(extensionId, ref, state, expectedRevision);
    } catch (error) {
      if (error instanceof AppError) return { error: { status: error.status, code: error.code } };
      throw error;
    }
  }
  private async writeResourceState(
    extensionId: string,
    ref: string,
    state: unknown,
    expectedRevision: number,
  ) {
    const { handler, key } = await this.resource(extensionId, ref);
    if (this.deleting) throw new AppError(404, 'not_found');
    if (!handler.validateState) throw new AppError(405, 'resource_read_only');
    let text: string;
    try {
      text = jsonText(handler.validateState(state));
    } catch {
      throw new AppError(400, 'invalid_state');
    }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      return { error: { status: 400, code: 'invalid_revision' } };
    let result = this.ctx.storage.sql
      .exec(
        'UPDATE app_inputs SET state=?,revision=revision+1,updated=? WHERE ref=? AND revision=? RETURNING revision',
        text,
        Date.now(),
        key,
        expectedRevision,
      )
      .toArray()[0];
    if (!result && expectedRevision === 0)
      result = this.ctx.storage.sql
        .exec(
          'INSERT INTO app_inputs(ref,state,revision,updated)VALUES(?,?,1,?) ON CONFLICT(ref) DO NOTHING RETURNING revision',
          key,
          text,
          Date.now(),
        )
        .toArray()[0];
    if (!result) return { error: { status: 409, code: 'revision_conflict' } };
    return { revision: Number(result.revision) };
  }
  async history(cursor?: Cursor) {
    const root = await this.root();
    return root.entries({ order: 'ascending' }, 100, cursor, BG);
  }
  private readContext(): ReadContext {
    return {
      entries: () => this.allEntries(),
      successfulTool: async (ref, name) =>
        readSuccessfulTool(await this.harness.pi(), ref, name, BG),
    };
  }
  async allEntries(): Promise<EntryRecord[]> {
    const all: EntryRecord[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await this.history(cursor);
      all.push(...page.items);
      cursor = page.next;
    } while (cursor);
    return all;
  }
  async observeRun(runId: string, threadId = '1'): Promise<Response> {
    if (this.deleting) return Response.json({ error: { code: 'not_found' } }, { status: 404 });
    return observeRun(this, runId, threadId);
  }
  async progressProjector() {
    return toolProjector(await this.contributions());
  }
  async extensionProjection() {
    return createExtensionProjection(
      await this.harness.pi(),
      await this.contributions(),
      this.rows<{ id: string }>('SELECT id FROM app_requests WHERE accepted<>-1').map(
        (row) => row.id,
      ),
      BG,
    );
  }
  async snapshot(rawCursor?: string): Promise<string> {
    if (this.deleting) return JSON.stringify({ error: { status: 404, code: 'not_found' } });
    let cursor: Cursor | undefined;
    try {
      cursor = rawCursor ? JSON.parse(rawCursor) : undefined;
    } catch {
      throw new AppError(400, 'invalid_cursor');
    }
    const pi = await this.harness.pi();
    const inspection = await pi.inspect(BG);
    const pending = await this.harness.pending({ session: '1' });
    const terminalTasks = await pi.commit(
      (tx) =>
        tx.scanTasks(
          { conversationId: ROOT_CONVERSATION_ID, status: 'terminal', order: 'descending' },
          100,
          undefined,
        ),
      BG,
    );
    let toolProgress, extensionState, firstHistory;
    if (!cursor) {
      const projection = await this.extensionProjection();
      const watch = await watchEvents(pi, ROOT_CONVERSATION_ID, BG);
      try {
        const facts = await projection.restore(true);
        firstHistory = facts.page;
        toolProgress = (
          await restoreToolProgress(pi, watch.snapshot, facts.entries, facts.tasks)
        ).project(await this.progressProjector());
        extensionState = projection.project();
      } finally {
        await watch.stop();
      }
    }
    const history = firstHistory ?? (await this.history(cursor));
    const modelCatalog = this.modelCatalog();
    const lastRequest = this.rows<{ payload: string }>(
      'SELECT payload FROM app_requests WHERE accepted<>-1 ORDER BY rowid DESC LIMIT 1',
    )[0];
    const previousRequest = lastRequest
      ? storedRequestSchema.parse(JSON.parse(lastRequest.payload))
      : undefined;
    const previous: ModelSelection | undefined = previousRequest
      ? {
          provider: previousRequest.execution.provider,
          modelId: previousRequest.execution.modelId,
          thinkingLevel: previousRequest.execution.thinkingLevel,
        }
      : undefined;
    // A removed model/effort falls back for the next message, without rewriting earlier requests.
    const option = modelCatalog.models.find(
      (m) => m.id === previous?.modelId && m.provider === previous?.provider,
    );
    const selection =
      previous && option?.thinkingLevels.includes(previous.thinkingLevel)
        ? previous
        : modelCatalog.defaultSelection;
    return JSON.stringify({
      entries: browserEntries(history.items),
      cursor: history.next,
      toolProgress,
      extensionState,
      pending,
      stopping: this.stopping,
      modelCatalog,
      selection,
      remote: remoteProgress(
        (await pi.snapshot(RemoteIntents, ROOT_CONVERSATION_ID, BG))?.operations ?? {},
      ),
      capabilityIssues: this.mcpPrepared?.diagnostics ?? [],
      runtimeIssues: terminalTasks.items
        .filter((t) => t.state.status === 'terminal' && t.state.outcome.status === 'orphaned')
        .map((t) => ({ taskId: Number(t.id), code: 'task_definition_unavailable' })),
      tools: inspection.tasks
        .filter((t) => t.record.kind === 'pi.tool')
        .map((t) => ({ taskId: Number(t.record.id) })),
    });
  }
}
