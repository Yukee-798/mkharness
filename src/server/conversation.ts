import { Agent } from 'agents';
import { LifecycleCapability } from 'agents/lifecycle';
import { PiHarness } from 'agents/harness/pi';
import {
  Harness,
  ROOT_CONVERSATION_ID,
  createRegistry,
  createSession,
  type Cursor,
  type Extension,
  type EntryRecord,
} from '@earendil-works/pi-durable';
import type { Models } from '@earendil-works/pi-ai/models';
import { AppError, commandSchema, USER_ACTION_CONTEXT, type RunCommand } from '../shared/contracts';
import { jsonText, canonicalJson } from '../shared/compute';
import { applicationExtensions } from './assembly';
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
import { withRunLimits, toolBudget } from './limits';
import { validateUI } from './panel-tools';
import { successfulTool } from '../shared/references';
import { observeRun } from './observe';
import { browserEntries } from '../shared/stream';
import {
  applicationModels,
  applicationThinkingLevel,
  applicationModelCatalog,
  validateModelSelection,
} from './models';
import type { ModelSelection } from '../shared/model-selection';
import { remoteProgress } from '../shared/remote-progress';
import { claimPiStorage, validatePiStorage, RuntimeStorageError } from './pi-storage';
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
  private admission: Promise<unknown> = Promise.resolve();
  private recovery: RequestRecovery;
  private stopWork?: Promise<void>;
  private deletionId?: string;
  private mcpPrepared?: Awaited<ReturnType<typeof buildMcp>>;
  private deleteWork?: Promise<void>;
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
          );
        const extensions = await this.extensions();
        validateExtensions(extensions);
        for (const extension of extensions) registry.install(extension);
        const pi = await Harness.open(
          storage,
          {
            models: withRunLimits(
              this.models(),
              () => this.allEntries(),
              () => this.modelDispatch(),
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
                  name: error instanceof Error ? error.name : typeof error,
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
  private thinkingLevel() {
    return applicationThinkingLevel(this.env as Env & { MODEL_THINKING_LEVEL?: string });
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
  private async runningCommand() {
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
    const stored = row
      ? (JSON.parse(row.payload) as RunCommand & { execution?: ModelSelection })
      : undefined;
    return stored;
  }
  private async modelDispatch() {
    const stored = await this.runningCommand();
    const doc = await (await this.harness.pi()).snapshot(RemoteIntents, ROOT_CONVERSATION_ID, BG);
    if (
      !remoteModelAllowed(doc?.operations ?? {}, stored) ||
      remoteRunBlocked(await this.allEntries())
    )
      throw new AppError(409, 'remote_outcome_unknown');
    const selection = stored?.execution ?? stored?.config ?? this.selection();
    const model = this.models().getModel(this.env.MODEL_PROVIDER, selection.modelId);
    if (!model)
      throw new AppError(
        503,
        'unknown_model',
        'Submitted model is absent from the installed Pi catalog',
      );
    return { model, thinkingLevel: selection.thinkingLevel };
  }
  protected mcpConfiguration(): MCPConfig[] {
    return mcpConfiguration(this.env as unknown as Record<string, unknown>);
  }
  protected remoteConfiguration(): RemoteConfig | undefined {
    return remoteConfiguration(this.env as unknown as Record<string, unknown>);
  }
  protected async extensions(): Promise<Extension[]> {
    const remote = this.remoteConfiguration();
    return [
      ...(await applicationExtensions(this.env, () => this.allEntries())),
      ...(this.mcpPrepared ? [this.mcpPrepared.extension] : []),
      ...(remote
        ? [
            remoteExample(remote, {
              identity: this.ctx.id.toString(),
              command: async () => {
                const command = await this.runningCommand();
                if (!command) throw new AppError(409, 'run_context_missing');
                return command;
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
    return pi.root(BG, {
      agent: {
        model: { provider: this.env.MODEL_PROVIDER, modelId: this.env.MODEL_ID },
        thinkingLevel: this.thinkingLevel(),
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
      if (record && canonicalJson(commandSchema.parse(JSON.parse(record.payload))) !== payload)
        throw new AppError(409, 'request_conflict');
      if (record?.accepted === -1) throw new AppError(409, 'request_withdrawn');
      if (!record) {
        await this.root();
        if (command.source) {
          if (command.source.action === 'continue_analysis') {
            if (!successfulTool(await this.allEntries(), command.source.panelRef, 'present_openui'))
              throw new AppError(404, 'panel_not_found');
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
        const execution = this.selection(command.config); // Validate and freeze settings before admission.
        const pending = await this.harness.pending({ session: '1' });
        if (!pending.length) await this.pruneCompletedRemote(command);
        if (pending.filter((p) => p.status === 'queued').length >= 10)
          throw new AppError(429, 'queue_full');
        this.ctx.storage.sql.exec(
          'INSERT INTO app_requests(id,payload)VALUES(?,?)',
          command.runId,
          canonicalJson(command.config ? command : { ...command, execution }),
        );
      }
      if (!record?.accepted) {
        await this.recovery.schedule();
        await this.enqueue(command);
      }
      return { runId: command.runId, accepted: true as const };
    });
  }
  private async pruneCompletedRemote(command: RunCommand) {
    const pi = await this.harness.pi();
    const saved = await pi.snapshot(RemoteIntents, ROOT_CONVERSATION_ID, BG);
    if (!saved) return;
    const referenced =
      command.source && command.source.action !== 'continue_analysis'
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
    if (completed.length)
      await pi.commit(async (tx) => {
        const doc = await tx.doc(RemoteIntents, ROOT_CONVERSATION_ID);
        for (const operation of completed)
          if (doc.operations[operation.taskId]?.status === 'completed')
            delete doc.operations[operation.taskId];
      }, BG);
  }
  private async enqueue(command: RunCommand) {
    let text = command.text;
    if (command.source) text += USER_ACTION_CONTEXT + '\n' + JSON.stringify(command.source);
    await this.harness.submit(text, {
      session: '1',
      operationId: command.runId,
      whenBusy: 'followUp',
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
      for (const record of this.rows<{ id: string; payload: string }>(
        'SELECT id,payload FROM app_requests WHERE accepted=0 ORDER BY rowid',
      )) {
        if (this.stopping) break;
        await this.enqueue(JSON.parse(record.payload) as RunCommand);
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
  async loadPanel(ref: string): Promise<string> {
    if (this.deleting) return JSON.stringify({ error: { status: 404, code: 'not_found' } });
    const entries = await this.allEntries(),
      panel = successfulTool(entries, ref, 'present_openui');
    if (!panel) return JSON.stringify({ error: { status: 404, code: 'panel_not_found' } });
    const programRef = panel.args.programRef;
    const program =
      typeof programRef === 'string'
        ? successfulTool(entries, programRef, 'prepare_program')
        : undefined;
    if (programRef && !program)
      return JSON.stringify({ error: { status: 409, code: 'program_not_recoverable' } });
    const saved = this.rows<{ state: string; revision: number }>(
      'SELECT state,revision FROM app_inputs WHERE ref=?',
      ref,
    )[0];
    return JSON.stringify({
      panelRef: ref,
      ui: panel.args.ui,
      program: program ? { code: program.args.code, data: program.args.data } : null,
      state: saved
        ? JSON.parse(saved.state)
        : (await validateUI(String(panel.args.ui), !!program)).stateDeclarations,
      revision: saved?.revision ?? 0,
    });
  }
  async savePanelState(
    ref: string,
    state: Record<string, unknown>,
    expectedRevision: number,
  ): Promise<{ revision: number } | { error: { status: number; code: string } }> {
    const panel = JSON.parse(await this.loadPanel(ref));
    if (panel.error) return panel;
    if (this.deleting) return { error: { status: 404, code: 'not_found' } };
    let text: string;
    try {
      text = jsonText(state);
    } catch {
      return { error: { status: 400, code: 'invalid_state' } };
    }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      return { error: { status: 400, code: 'invalid_revision' } };
    let result = this.ctx.storage.sql
      .exec(
        'UPDATE app_inputs SET state=?,revision=revision+1,updated=? WHERE ref=? AND revision=? RETURNING revision',
        text,
        Date.now(),
        ref,
        expectedRevision,
      )
      .toArray()[0];
    if (!result && expectedRevision === 0)
      result = this.ctx.storage.sql
        .exec(
          'INSERT INTO app_inputs(ref,state,revision,updated)VALUES(?,?,1,?) ON CONFLICT(ref) DO NOTHING RETURNING revision',
          ref,
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
    const history = await this.history(cursor);
    const modelCatalog = this.modelCatalog();
    const lastRequest = this.rows<{ payload: string }>(
      'SELECT payload FROM app_requests WHERE accepted<>-1 ORDER BY rowid DESC LIMIT 1',
    )[0];
    const previousRequest = lastRequest ? JSON.parse(lastRequest.payload) : undefined;
    const previous = (previousRequest?.config ?? previousRequest?.execution) as
      ModelSelection | undefined;
    // A removed model/effort falls back for the next message, without rewriting earlier requests.
    const option = modelCatalog.models.find((m) => m.id === previous?.modelId);
    const selection =
      previous && option?.thinkingLevels.includes(previous.thinkingLevel)
        ? previous
        : modelCatalog.defaultSelection;
    return JSON.stringify({
      entries: browserEntries(history.items),
      cursor: history.next,
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
