import { Agent } from 'agents';
import { LifecycleCapability } from 'agents/lifecycle';
import { PiHarness } from 'agents/harness/pi';
import {
  Harness,
  createRegistry,
  type Cursor,
  type Extension,
  type EntryRecord,
} from '@earendil-works/pi-durable';
import type { Models } from '@earendil-works/pi-ai/models';
import { AppError, commandSchema, USER_ACTION_CONTEXT, type RunCommand } from '../shared/contracts';
import { jsonText, canonicalJson } from '../shared/compute';
import { webTools } from './web';
import { runLimits, withRunLimits } from './limits';
import { panelTools, validateUI } from './panel-tools';
import { successfulTool } from '../shared/references';
import { observeRun } from './observe';
import { browserEntries } from '../shared/stream';
import { applicationModels, applicationThinkingLevel } from './models';
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
  private deleteWork?: Promise<void>;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
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
      harness: async ({ storage, context }) => {
        const registry = createRegistry();
        for (const extension of this.extensions()) registry.install(extension);
        return Harness.open(
          storage,
          {
            models: withRunLimits(this.models(), () => this.allEntries()),
            registry,
            settings: {
              followUpMode: 'one-at-a-time',
              steeringMode: 'one-at-a-time',
              toolExecution: 'sequential',
            },
            onReport: () => console.error(JSON.stringify({ stage: 'pi', error: 'runtime_report' })),
          },
          context,
        );
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
  protected extensions(): Extension[] {
    return [
      panelTools(() => this.allEntries()),
      webTools((this.env as Env & { TAVILY_API_KEY?: string }).TAVILY_API_KEY),
      runLimits(() => this.allEntries()),
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
      if (record && canonicalJson(JSON.parse(record.payload)) !== payload)
        throw new AppError(409, 'request_conflict');
      if (record?.accepted === -1) throw new AppError(409, 'request_withdrawn');
      if (!record) {
        if (command.source) {
          if (command.source.action !== 'continue_analysis')
            throw new AppError(400, 'invalid_action');
          if (!successfulTool(await this.allEntries(), command.source.panelRef, 'present_openui'))
            throw new AppError(404, 'panel_not_found');
        }
        this.models(); // Fail before admitting a request with missing model configuration.
        this.thinkingLevel();
        const pending = await this.harness.pending({ session: '1' });
        if (pending.filter((p) => p.status === 'queued').length >= 10)
          throw new AppError(429, 'queue_full');
        this.ctx.storage.sql.exec(
          'INSERT INTO app_requests(id,payload)VALUES(?,?)',
          command.runId,
          payload,
        );
      }
      if (!record?.accepted) {
        await this.recovery.schedule();
        await this.enqueue(command);
      }
      return { runId: command.runId, accepted: true as const };
    });
  }
  private async enqueue(command: RunCommand) {
    // Apply the host's choice through Pi's public settings before a new submission. This also
    // enables future reasoning in existing chats without rewriting their earlier history.
    const root = await this.root();
    const thinkingLevel = this.thinkingLevel();
    if ((await root.agent(BG)).thinkingLevel !== thinkingLevel)
      await root.configure({ thinkingLevel }, BG);
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
    const history = await this.history(cursor);
    return JSON.stringify({
      entries: browserEntries(history.items),
      cursor: history.next,
      pending,
      stopping: this.stopping,
      tools: inspection.tasks
        .filter((t) => t.record.kind === 'pi.tool')
        .map((t) => ({ taskId: Number(t.record.id) })),
    });
  }
}
