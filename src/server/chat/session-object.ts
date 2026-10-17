import { DurableObject } from 'cloudflare:workers';
import { BG } from './context';
import {
  Harness,
  AgentDoc,
  InboxDoc,
  LiveDoc,
  GenerationTask,
  CompactionTask,
  configure,
  type ConversationId,
  type Conversation,
  type Cursor,
  type EntryRecord,
  type EntryId,
  type Extension,
  type SubmissionId,
  type GenerationCheckpoint,
  type CompactionCheckpoint,
} from '@earendil-works/pi-durable';
import type { Models } from '@earendil-works/pi-ai/models';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { DurableObjectSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/cloudflare';
import {
  extensionConfiguration,
  extensionEnabled,
  type ExtensionConfiguration,
} from '../../extensions/configuration';
import {
  AppError,
  commandSchema,
  USER_ACTION_CONTEXT,
  type RunCommand,
  type StoredRequest,
} from '../../shared/contracts';
import { jsonText, canonicalJson, type Json } from '../../shared/json';
import { userContent, imageModelError } from '../../shared/images';
import type { QueuedInput, QueueAction } from '../../shared/queue';
import type { ModelSelection } from '../../shared/model-selection';
import type { ConnectionBinding } from '../../shared/mcp-connections';
import type { SkillBinding } from '../../shared/skills';
import { applicationContributions } from '../extensions/assembly';
import type { ReadContext, ServerContribution } from '../extensions/contributions';
import { validateExtensions } from '../extensions/registry';
import {
  applicationModels,
  applicationModelCatalog,
  configuredModelCatalog,
  validateModelSelection,
} from '../models/catalog';
import {
  executionModels,
  bindStoredExecution,
  restoreExecutionModels,
  type CredentialAccess,
} from '../models/execution';
import { ModelCredentials } from '../models/credentials';
import { buildMcp, mcpConfiguration, type MCPBinding, type MCPConfig } from '../mcp/deployment';
import { runLimits, guardModels, toolBudget } from '../limits';
import { ChatRuntime } from './runtime';
import { admitExecutionPolicy, authorizeExternalTarget } from './policy';
import { drainMcpAcknowledgements, mcpAcknowledgementTasks } from '../mcp/acknowledgement';
import { QueueEditTransfers } from './queue-edits';
import { conversationScope } from './scope';
import { ChatResources } from './resources';
import { withdrawFailedFollowers } from './admission-recovery';
import {
  Admissions,
  PendingAdmissions,
  ExecutionBinding,
  ConversationControl,
  ModelTarget,
  admissionKey,
  bindingKey,
  type AdmissionReceipt,
} from './documents';
import { ConversationReadModel } from './read-model';
import { readSuccessfulTool, readInputForAnswer } from './history';
import type { ChatActor, ChatCommand, ChatReadQuery, ChatObservationQuery } from './protocol';

type Manifest = ChatActor & {
  mainConversationId?: number;
  mcpBindings: ConnectionBinding[];
  skillBindings: SkillBinding[];
  deploymentBindings: MCPBinding[];
};
type ErrorReply = { error: { status: number; code: string; message: string } };
const errorReply = (error: unknown): ErrorReply => {
  if (!(error instanceof AppError))
    console.error(
      JSON.stringify({
        stage: 'chat',
        name: error instanceof Error ? error.name : 'error',
        frames: error instanceof Error ? error.stack?.split('\n').slice(1, 5) : [],
      }),
    );
  return {
    error: {
      status: error instanceof AppError ? error.status : 503,
      code: error instanceof AppError ? error.code : 'chat_unavailable',
      message: error instanceof AppError ? error.message : '会话暂时不可用，请重试',
    },
  };
};

/** One product chat owns one native Pi Session, including its forks and task-owned children. */
export class ChatSession extends DurableObject<Env> {
  private runtime: ChatRuntime;
  private resourceStore?: ChatResources;
  private manifest?: Manifest;
  private deleted = false;
  private erased = false;
  private gate: Promise<unknown> = Promise.resolve();
  private runtimeModels?: ReturnType<typeof executionModels>;
  private contributionSet?: Promise<readonly ServerContribution[]>;
  private initialized?: Promise<Harness>;
  private stoppingTargets = new Set<number>();
  private stoppingRoots = new Set<number>();
  private activeCommands = 0;
  private ready?: Harness;
  private watchedTasks = new Set<number>();
  private stopJobs = new Map<number, Promise<void>>();
  private closingForDelete?: Promise<void>;
  private alarmLine: Promise<void> = Promise.resolve();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.runtime = new ChatRuntime(ctx);
    // Constructors load local control only: no providers, MCP, OAuth, D1 or Pi scheduler.
    ctx.blockConcurrencyWhile(async () => {
      this.manifest = await ctx.storage.get<Manifest>('manifest');
      this.deleted = (await ctx.storage.get<boolean>('deleting')) === true;
    });
  }
  protected models(): Models {
    return applicationModels(this.env);
  }
  protected async credentials(): Promise<CredentialAccess> {
    return new ModelCredentials(this.env, this.identity().ownerId);
  }
  protected mcpConfiguration(): MCPConfig[] {
    return mcpConfiguration(this.env as unknown as Record<string, unknown>);
  }
  protected extensionConfiguration(): ExtensionConfiguration {
    return extensionConfiguration;
  }
  private identity(): Manifest {
    if (!this.manifest || this.deleted) throw new AppError(404, 'not_found');
    return this.manifest;
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const work = this.gate.then(fn);
    this.gate = work.catch(() => {});
    return work;
  }
  protected async authorize(actor: ChatActor, deletion = false) {
    if (this.ctx.id.toString() !== this.env.CONVERSATIONS.idFromName(actor.chatId).toString())
      throw new AppError(404, 'not_found');
    const row = await this.env.DB.prepare(
      'SELECT owner,instance_generation,lifecycle FROM conversations WHERE id=?',
    )
      .bind(actor.chatId)
      .first<{ owner: string; instance_generation: string; lifecycle: string }>();
    if (
      !row ||
      row.owner !== actor.ownerId ||
      row.instance_generation !== actor.generation ||
      (!deletion && row.lifecycle !== 'active')
    )
      throw new AppError(404, 'not_found');
    if (
      this.manifest &&
      (this.manifest.chatId !== actor.chatId ||
        this.manifest.ownerId !== actor.ownerId ||
        this.manifest.generation !== actor.generation)
    )
      throw new AppError(404, 'not_found');
    if (deletion && row.lifecycle === 'deleted' && !this.manifest) {
      this.deleted = true;
      this.erased = true;
      return;
    }
    if (!this.manifest) {
      if (row.lifecycle !== 'active' && !deletion) throw new AppError(404, 'not_found');
      const bindings = async <T>(table: string): Promise<T[]> => {
        const value = await this.env.DB.prepare(
          `SELECT bindings FROM ${table} WHERE conversation=?`,
        )
          .bind(actor.chatId)
          .first<string>('bindings');
        return value ? (JSON.parse(value) as T[]) : [];
      };
      const [mcpBindings, skillBindings, deploymentBindings] = await Promise.all([
        bindings<ConnectionBinding>('conversation_mcp_bindings'),
        bindings<SkillBinding>('conversation_skill_bindings'),
        bindings<MCPBinding>('conversation_deployment_mcp_bindings'),
      ]);
      // Recheck after asynchronous directory reads; a delayed request cannot initialize a deleted generation.
      const active = await this.env.DB.prepare(
        'SELECT lifecycle FROM conversations WHERE id=? AND owner=? AND instance_generation=?',
      )
        .bind(actor.chatId, actor.ownerId, actor.generation)
        .first<string>('lifecycle');
      if (!deletion && active !== 'active') throw new AppError(404, 'not_found');
      // Concurrent first requests must retain the object that open() is initializing.
      this.manifest ??= { ...actor, mcpBindings, skillBindings, deploymentBindings };
      await this.ctx.storage.put('manifest', this.manifest);
    }
    if (this.deleted && !deletion) throw new AppError(404, 'not_found');
  }
  protected contributionHost() {
    const m = this.identity();
    return {
      identity: m.chatId,
      ownerId: m.ownerId,
      conversationId: m.chatId,
      mcpBindings: m.mcpBindings,
      skillBindings: m.skillBindings,
      pi: () => this.pi(),
      command: (target: number) => this.runningCommand(target as ConversationId),
    };
  }
  protected contributions(): Promise<readonly ServerContribution[]> {
    return (this.contributionSet ??= applicationContributions(
      this.env,
      (target) => this.activeEntries(target as ConversationId),
      this.contributionHost(),
      this.extensionConfiguration(),
    ).catch((error) => {
      this.contributionSet = undefined;
      throw error;
    }));
  }
  protected async extensions(): Promise<Extension[]> {
    const manifest = this.identity();
    const extensions = [
      runLimits(() => this.pi(), toolBudget(this.env as unknown as Record<string, unknown>)),
      ...(await this.contributions()).flatMap((c) => (c.extension ? [c.extension] : [])),
      ...(extensionEnabled('mcp', this.extensionConfiguration()) &&
      manifest.deploymentBindings.length
        ? [
            buildMcp(
              this.env,
              { ownerId: manifest.ownerId, chatId: manifest.chatId },
              this.mcpConfiguration(),
              manifest.deploymentBindings,
            ).extension,
          ]
        : []),
    ];
    // Confirmation of already committed effects survives disabling MCP access.
    const registered = new Set(
      extensions.flatMap((extension) =>
        (extension.tasks ?? []).map((task) => task.definition.name),
      ),
    );
    extensions.push({
      name: 'mcp-confirmations',
      tasks: mcpAcknowledgementTasks(this.env).filter(
        (task) => !registered.has(task.definition.name),
      ),
    });
    return extensions;
  }
  protected mainId(): ConversationId {
    const id = this.identity().mainConversationId;
    if (!id) throw new AppError(503, 'chat_not_initialized');
    return id as ConversationId;
  }
  protected pi(): Promise<Harness> {
    return (this.initialized ??= this.open().catch(async (error) => {
      await this.runtime.close().catch(() => {});
      this.ctx.abort('Chat initialization failed');
      throw error;
    }));
  }
  private async open(): Promise<Harness> {
    const manifest = this.identity();
    // Even a stored local manifest is not authority to resurrect a wiped/deleted chat.
    await this.authorize(manifest);
    const models = executionModels(this.models());
    this.runtimeModels = models;
    const extensions = await this.extensions();
    validateExtensions(extensions);
    const guarded = guardModels(models, async (sessionId) => {
      const pi = await this.pi();
      const mapping = await pi.snapshot(ModelTarget, sessionId, BG);
      if (!mapping) throw new AppError(503, 'model_target_missing');
      const target = mapping.conversationId as ConversationId;
      const entries = await this.activeEntries(target);
      for (const contribution of await this.contributions())
        await contribution.execution?.beforeModel?.({
          pi,
          nativeConversationId: Number(target),
          entries,
          context: BG,
          command: await this.runningCommand(target),
        });
      return { pi, conversationId: Number(target), entries, context: BG };
    });
    const skillCapabilities = manifest.skillBindings.map(({ id, name }) => ({ id, name }));
    if (extensionEnabled('skills-example', this.extensionConfiguration())) {
      const { exampleSkillSource } = await import('../../extensions/skills/example');
      const source = exampleSkillSource();
      for (const skill of await source.list())
        skillCapabilities.push({ id: source.id, name: skill.name });
    }
    const pi = await this.runtime.open({
      models: guarded,
      extensions,
      policy: {
        tools: extensions.flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name)),
        mcp: [
          ...manifest.mcpBindings.map((binding) => `user:${binding.connectionId}`),
          ...manifest.deploymentBindings.map((binding) => `deployment:${binding.serverId}`),
        ],
        toolScopes: Object.fromEntries([
          ...manifest.mcpBindings.map((binding) => [
            binding.name,
            { mcp: `user:${binding.connectionId}` },
          ]),
          ...manifest.deploymentBindings.map((binding) => [
            binding.name,
            { mcp: `deployment:${binding.serverId}` },
          ]),
        ]),
        skills: skillCapabilities.map((binding) => binding.id),
        skillNames: Object.fromEntries(
          skillCapabilities.map((binding) => [binding.name, binding.id]),
        ),
        limits: { toolCalls: toolBudget(this.env as unknown as Record<string, unknown>) },
      },
      restore: async (session) => {
        await restoreExecutionModels(
          session,
          models,
          async (refs) => {
            const result: { execution: StoredRequest['execution'] }[] = [];
            for (const ref of refs) {
              const value = await session.snapshot(
                ExecutionBinding,
                bindingKey(ref.provider, ref.modelId),
                BG,
              );
              if (value) result.push({ execution: JSON.parse(value.execution) });
            }
            return result;
          },
          () => this.credentials(),
          BG,
        );
      },
      committed: () => {
        if (!this.deleted && this.ready) this.ctx.waitUntil(this.rearm(this.ready));
      },
    });
    if (!manifest.mainConversationId) {
      const selected = applicationModelCatalog(this.env, this.models()).defaultSelection;
      const root = await pi.root(BG, {
        agent: {
          model: { provider: selected.provider, modelId: selected.modelId },
          thinkingLevel: selected.thinkingLevel,
        },
      });
      manifest.mainConversationId = Number(root.id);
      await this.ctx.storage.put('manifest', manifest);
    }
    // Recovery has priority over native scheduling. No provider runs before its durable wake is armed.
    const inspection = await pi.inspect(BG);
    for (const task of inspection.tasks) {
      const id = task.record.conversationId;
      if ((await pi.snapshot(ConversationControl, id, BG))?.stopping)
        this.stoppingRoots.add(Number(id));
    }
    let cursor: Cursor | undefined;
    do {
      const page = await pi.commit((tx) => tx.scanConversations({}, 100, cursor), BG);
      for (const c of page.items)
        if ((await pi.snapshot(ConversationControl, c.id, BG))?.stopping)
          this.stoppingRoots.add(Number(c.id));
      cursor = page.next;
    } while (cursor);
    await this.arm();
    await this.refreshStopping(pi);
    for (const target of [...this.stoppingRoots])
      await this.finishStop(pi, target as ConversationId);
    for (const id of new Set(
      inspection.submissions
        .filter((s) => s.type === 'input' && s.status === 'queued')
        .map((s) => s.conversationId),
    ))
      await withdrawFailedFollowers(pi, id, BG);
    await this.reconcilePrepared(pi);
    await this.queueEdits(pi).recover();
    this.ready = pi;
    pi.resume();
    this.ctx.waitUntil(this.rearm(pi));
    return pi;
  }
  protected async target(raw?: number): Promise<Conversation> {
    if (raw !== undefined && (!Number.isSafeInteger(raw) || raw < 1))
      throw new AppError(400, 'invalid_conversation');
    const pi = await this.pi();
    const conversation = await pi.conversation(
      raw === undefined ? this.mainId() : (raw as ConversationId),
      BG,
    );
    if (!conversation) throw new AppError(404, 'conversation_not_found');
    try {
      await authorizeExternalTarget(pi, conversation.id, BG);
    } catch (error) {
      if (error instanceof AppError && error.code === 'external_conversation_denied')
        throw new AppError(404, 'not_found');
      throw error;
    }
    await this.isStopping(pi, conversation.id);
    return conversation;
  }
  protected async activeEntries(target: ConversationId): Promise<readonly EntryRecord[]> {
    const pi = await this.pi();
    const conversation = await pi.conversation(target, BG);
    if (!conversation) throw new AppError(404, 'conversation_not_found');
    return (await conversation.context(BG)).entries;
  }
  private async runningCommand(target: ConversationId) {
    const pi = await this.pi();
    const input = (await pi.inspect(BG)).submissions.find(
      (s) => s.conversationId === target && s.type === 'input' && s.status === 'placed',
    );
    if (!input || !('entry' in input) || !input.entry) return;
    const entry = await this.visibleEntry(pi, target, Number(input.entry));
    return this.inputData(entry)?.request;
  }
  private async visibleEntry(pi: Harness, target: ConversationId, id: number) {
    return pi.commit(
      async (tx) =>
        (
          await tx.scanEntries(
            { conversationId: target, minEntryId: id as EntryId, maxEntryId: id as EntryId },
            1,
          )
        ).items[0],
      BG,
    );
  }
  private inputData(entry?: EntryRecord) {
    if (
      entry?.kind !== 'app.input' ||
      !entry.data ||
      typeof entry.data !== 'object' ||
      Array.isArray(entry.data)
    )
      return;
    return entry.data as unknown as { request: RunCommand; context?: Json };
  }
  private async modelCatalog() {
    return configuredModelCatalog(
      this.env,
      this.models(),
      (await (await this.credentials()).configuredModels?.()) ?? [],
    );
  }
  protected async pending(target: ConversationId) {
    const pi = await this.pi();
    return (await pi.inspect(BG)).submissions.flatMap((s) =>
      s.conversationId === target &&
      s.type === 'input' &&
      (s.status === 'placed' || s.status === 'queued') &&
      s.requestId
        ? [
            {
              operationId: s.requestId,
              status: s.status === 'placed' ? ('running' as const) : ('queued' as const),
            },
          ]
        : [],
    );
  }
  protected async queuedInputs(target: ConversationId): Promise<QueuedInput[]> {
    const pi = await this.pi();
    return pi.commit(async (tx) => {
      const inbox = await tx.doc(InboxDoc, target);
      const items: QueuedInput[] = [];
      for (const item of inbox.items) {
        if (item.mode === 'write') continue;
        const data = item.entry?.data as unknown as { request?: RunCommand } | undefined;
        const command = data?.request;
        if (!command || !command.runId) continue;
        items.push({
          runId: command.runId,
          text: command.text,
          mode: item.mode,
          ...(command.images
            ? {
                images: command.images.map((image, index) => ({
                  name: image.name,
                  mimeType: image.mimeType,
                  ...(index === 0 && image.data.length <= 32768 ? { data: image.data } : {}),
                })),
              }
            : {}),
        });
      }
      return items.sort((a, b) => Number(b.mode === 'steer') - Number(a.mode === 'steer'));
    }, BG);
  }
  private async admit(conversation: Conversation, raw: RunCommand) {
    const parsed = commandSchema.safeParse(raw);
    if (!parsed.success) throw new AppError(400, 'invalid_request');
    const command = parsed.data,
      pi = await this.pi(),
      target = conversation.id;
    if (await this.isStopping(pi, target)) throw new AppError(409, 'stopping');
    await this.reconcilePrepared(pi);
    const key = admissionKey(target, command.runId),
      hash = await digest(canonicalJson(command));
    const prior = await pi.snapshot(Admissions, key, BG);
    if (prior) {
      if (prior.hash !== hash) throw new AppError(409, 'request_conflict');
      if (prior.state === 'withdrawn') throw new AppError(409, 'request_withdrawn');
      await this.place(pi, key, prior);
      return { runId: command.runId, accepted: true as const };
    }
    const pending = await this.pending(target);
    if (pending.filter((p) => p.status === 'queued').length >= 10)
      throw new AppError(429, 'queue_full');
    let sourceContext: Json | undefined;
    if (command.source) {
      const source = command.source;
      const actions = (await this.contributions()).find(
        (c) => c.id === source.extensionId,
      )?.actions;
      if (!actions || !Object.hasOwn(actions, source.name))
        throw new AppError(404, 'extension_action_unavailable');
      sourceContext = await actions[source.name]!.normalize(
        structuredClone(source.payload),
        this.readContext(target),
      );
      jsonText(sourceContext);
    }
    const selection = validateModelSelection(
      this.env,
      this.models(),
      command.config ?? (await this.modelCatalog()).defaultSelection,
    );
    if (
      command.images?.length &&
      !this.models().getModel(selection.provider, selection.modelId)?.input.includes('image')
    )
      throw new AppError(400, 'model_images_unsupported', imageModelError);
    const execution = {
      ...selection,
      credentialRef: await (await this.credentials()).select(selection.provider, selection.modelId),
    };
    if (!pending.length)
      for (const c of await this.contributions())
        await c.execution?.beforeSubmit?.({
          pi,
          nativeConversationId: Number(target),
          context: BG,
          command,
          entries: await this.activeEntries(target),
        });
    const stored: StoredRequest = {
      request: command,
      execution,
      ...(sourceContext === undefined ? {} : { sourceContext }),
    };
    const provider = await bindStoredExecution(this.runtimeModels!, execution, () =>
      this.credentials(),
    );
    const executionKey = bindingKey(provider, execution.modelId);
    await this.arm();
    // Configuration and the recoverable admission intent share a native commit.
    await pi.commit(async (tx) => {
      const pending = await tx.doc(PendingAdmissions);
      const live = await tx.doc(LiveDoc, target),
        inbox = await tx.doc(InboxDoc, target);
      const antecedents = [
        ...new Set([
          ...(live.run?.inputs ?? []),
          ...inbox.items.filter((item) => item.mode !== 'write').map((item) => item.id),
        ]),
      ].map(Number);
      await tx.doc(ExecutionBinding, executionKey, JSON.stringify(execution));
      await admitExecutionPolicy(tx, target, command.runId, {
        model: { provider, modelId: execution.modelId },
      });
      await configure(tx, target, {
        model: { provider, modelId: execution.modelId },
        thinkingLevel: execution.thinkingLevel,
      });
      await tx.doc(Admissions, key, {
        hash,
        state: 'prepared',
        conversationId: Number(target),
        requestId: command.runId,
        antecedents,
        pendingInput: jsonText(stored, 2 * 1048576 + 65536),
      });
      pending.keys.push(key);
    }, BG);
    const receipt = await pi.snapshot(Admissions, key, BG);
    await this.place(pi, key, receipt!);
    return { runId: command.runId, accepted: true as const };
  }
  private async place(pi: Harness, key: string, receipt: Readonly<AdmissionReceipt>) {
    if (receipt.state === 'withdrawn') throw new AppError(409, 'request_withdrawn');
    const target = receipt.conversationId as ConversationId;
    let native = await pi.commit((tx) => tx.submissionByRequest(target, receipt.requestId), BG);
    if (!native && receipt.state === 'prepared') {
      if (await this.isStopping(pi, target)) {
        await this.withdraw(pi, key);
        return;
      }
      for (const id of receipt.antecedents ?? []) {
        const previous = await pi.submission(id as SubmissionId, BG);
        if (!previous) throw new AppError(503, 'antecedent_receipt_missing');
        const status = await previous.status(BG);
        if (
          status.type === 'input' &&
          status.status === 'unanswered' &&
          status.entry !== undefined
        ) {
          await this.withdraw(pi, key);
          throw new AppError(409, 'request_withdrawn');
        }
      }
      const stored = JSON.parse(receipt.pendingInput!) as StoredRequest;
      let text = stored.request.text;
      if (stored.sourceContext !== undefined)
        text += USER_ACTION_CONTEXT + '\n' + JSON.stringify(stored.sourceContext);
      const conversation = await pi.conversation(target, BG);
      if (!conversation) throw new AppError(404, 'conversation_not_found');
      await this.arm();
      const submission = await conversation.submit(
        {
          type: 'input',
          requestId: receipt.requestId,
          content: userContent(text, stored.request.images),
          whenBusy: 'followUp',
          entry: {
            kind: 'app.input',
            data: JSON.parse(
              jsonText({
                request: stored.request,
                ...(stored.sourceContext === undefined ? {} : { context: stored.sourceContext }),
              }),
            ),
          },
        },
        BG,
      );
      native = await submission.status(BG);
    }
    if (!native) throw new AppError(503, 'admission_receipt_missing');
    const withdrawn =
      native.type === 'input' &&
      native.status === 'unanswered' &&
      native.entry === undefined &&
      native.reason === 'aborted';
    await pi.commit(async (tx) => {
      const current = await tx.doc(Admissions, key, receipt as AdmissionReceipt);
      current.state = withdrawn ? 'withdrawn' : 'admitted';
      current.submissionId = Number(native!.id);
      delete current.pendingInput;
      delete current.antecedents;
      const pending = await tx.doc(PendingAdmissions);
      pending.keys = pending.keys.filter((k) => k !== key);
    }, BG);
    if (withdrawn) throw new AppError(409, 'request_withdrawn');
  }
  private async withdraw(pi: Harness, key: string) {
    const receipt = await pi.snapshot(Admissions, key, BG);
    if (!receipt) return;
    await pi.commit(async (tx) => {
      const doc = await tx.doc(Admissions, key, receipt as AdmissionReceipt);
      doc.state = 'withdrawn';
      delete doc.pendingInput;
      delete doc.antecedents;
      const pending = await tx.doc(PendingAdmissions);
      pending.keys = pending.keys.filter((k) => k !== key);
    }, BG);
  }
  private async reconcilePrepared(pi: Harness) {
    const pending = await pi.snapshot(PendingAdmissions, BG);
    for (const key of pending?.keys ?? []) {
      const receipt = await pi.snapshot(Admissions, key, BG);
      if (!receipt) throw new AppError(503, 'admission_receipt_missing');
      if (await this.isStopping(pi, receipt.conversationId as ConversationId))
        await this.withdraw(pi, key);
      else
        try {
          await this.place(pi, key, receipt);
        } catch (error) {
          if (!(error instanceof AppError) || error.code !== 'request_withdrawn') throw error;
        }
    }
  }
  private async queueAction(conversation: Conversation, runId: string, action: QueueAction) {
    if (
      !commandSchema.shape.runId.safeParse(runId).success ||
      !['edit', 'steer', 'remove'].includes(action)
    )
      throw new AppError(400, 'invalid_request');
    const pi = await this.pi(),
      target = conversation.id;
    if (action === 'edit') {
      const saved = await this.queueEdits(pi).existing(target, runId);
      if (saved) return { queue: await this.queuedInputs(target), ...saved };
    }
    if (await this.isStopping(pi, target)) throw new AppError(409, 'stopping');
    if (action === 'edit') {
      await this.arm();
      const draft = await this.queueEdits(pi).edit(target, runId);
      return { queue: await this.queuedInputs(target), ...(draft ? { draft } : {}) };
    }
    const submission = await pi.commit((tx) => tx.submissionByRequest(target, runId), BG);
    if (!submission || submission.type !== 'input') throw new AppError(404, 'run_not_found');
    if (
      submission.status === 'unanswered' &&
      !submission.entry &&
      submission.reason === 'aborted'
    ) {
      if (action === 'remove') return { queue: await this.queuedInputs(target) };
      throw new AppError(409, 'request_withdrawn');
    }
    await conversation.commit(async (tx) => {
      const inbox = await tx.doc(InboxDoc, target),
        item = inbox.items.find((i) => i.id === submission.id);
      if (!item || item.mode === 'write') throw new AppError(409, 'queue_item_started');
      if (action === 'steer') item.mode = 'steer';
    }, BG);
    await this.arm();
    if (action === 'steer') pi.resume();
    else {
      if ((await pi.abortSubmission(submission.id, BG, target)) !== 'aborted')
        throw new AppError(409, 'queue_item_started');
      await this.withdraw(pi, admissionKey(target, runId));
    }
    return { queue: await this.queuedInputs(target) };
  }
  private queueEdits(pi: Harness) {
    return new QueueEditTransfers(pi, (key) => this.withdraw(pi, key));
  }
  private async stop(conversation: Conversation) {
    const pi = await this.pi(),
      target = conversation.id;
    this.stoppingRoots.add(Number(target));
    await this.refreshStopping(pi);
    await this.arm();
    await conversation.commit(async (tx) => {
      const doc = await tx.doc(ConversationControl, target);
      doc.stopping = true;
    }, BG);
    this.ctx.waitUntil(this.finishStop(pi, target).then(() => this.rearm(pi)));
    return { stopping: true as const };
  }
  private finishStop(pi: Harness, target: ConversationId): Promise<void> {
    const existing = this.stopJobs.get(Number(target));
    if (existing) return existing;
    const work = this.drainStop(pi, target).finally(() => {
      this.stopJobs.delete(Number(target));
    });
    this.stopJobs.set(Number(target), work);
    return work;
  }
  private async drainStop(pi: Harness, target: ConversationId) {
    for (const key of (await pi.snapshot(PendingAdmissions, BG))?.keys ?? []) {
      const receipt = await pi.snapshot(Admissions, key, BG);
      if (
        receipt &&
        (await pi.commit(
          (tx) =>
            conversationScope(tx)(
              receipt.conversationId as ConversationId,
              new Set([Number(target)]),
            ),
          BG,
        ))
      )
        await this.withdraw(pi, key);
    }
    const conversation = await pi.conversation(target, BG);
    if (conversation) await conversation.abort(BG, { background: true });
    await pi.commit(async (tx) => {
      (await tx.doc(ConversationControl, target)).stopping = false;
    }, BG);
    this.stoppingRoots.delete(Number(target));
    await this.refreshStopping(pi);
  }
  private async isStopping(pi: Harness, target: ConversationId) {
    const value = await pi.commit((tx) => conversationScope(tx)(target, this.stoppingRoots), BG);
    if (value) this.stoppingTargets.add(Number(target));
    else this.stoppingTargets.delete(Number(target));
    return value;
  }
  private async refreshStopping(pi: Harness) {
    const targets = new Set<number>();
    let cursor: Cursor | undefined;
    do {
      const page = await pi.commit(async (tx) => {
        const page = await tx.scanConversations({}, 100, cursor),
          inScope = conversationScope(tx);
        for (const c of page.items)
          if (await inScope(c.id, this.stoppingRoots)) targets.add(Number(c.id));
        return page;
      }, BG);
      cursor = page.next;
    } while (cursor);
    this.stoppingTargets = targets;
  }
  private arm(): Promise<void> {
    return this.alarmWork(() => this.ctx.storage.setAlarm(Date.now() + 60_000));
  }
  private alarmWork(work: () => Promise<void>): Promise<void> {
    const next = this.alarmLine.then(() => (this.erased ? undefined : work()));
    this.alarmLine = next.catch(() => {});
    return next;
  }
  private rearm(opened?: Harness): Promise<void> {
    return this.alarmWork(() => this.updateAlarm(opened));
  }
  private async updateAlarm(opened?: Harness) {
    if (this.deleted) {
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      return;
    }
    const pi = opened ?? this.ready;
    if (!pi) return;
    const inspection = await pi.inspect(BG);
    for (const id of new Set(
      inspection.submissions
        .filter((s) => s.type === 'input' && s.status === 'queued')
        .map((s) => s.conversationId),
    ))
      await withdrawFailedFollowers(pi, id, BG);

    const pending = (await pi.snapshot(PendingAdmissions, BG))?.keys.length ?? 0;
    const editDeadline = await this.queueEdits(pi).maintenance();
    if (
      inspection.tasks.length ||
      inspection.submissions.length ||
      pending ||
      this.stoppingTargets.size ||
      this.activeCommands ||
      editDeadline !== undefined
    ) {
      const now = Date.now();
      let deadline = now + (pending || this.stoppingTargets.size ? 1000 : 60_000);
      if (editDeadline !== undefined) deadline = Math.min(deadline, editDeadline);
      for (const task of inspection.tasks) {
        if (
          task.record.kind !== GenerationTask.definition.name &&
          task.record.kind !== CompactionTask.definition.name
        )
          continue;
        const checkpoint = task.record.state.checkpoint as
          GenerationCheckpoint | CompactionCheckpoint | undefined;
        const wake =
          checkpoint?.phase === 'retry'
            ? checkpoint.until
            : checkpoint?.phase === 'poll'
              ? checkpoint.pollAt
              : undefined;
        if (wake !== undefined && Number.isFinite(wake))
          deadline = Math.min(deadline, Math.max(now + 1000, wake));
      }
      await this.ctx.storage.setAlarm(deadline);
      // Native waiters join live invocations; the durable alarm remains the cold-wake authority.
      for (const task of inspection.tasks)
        if (!this.watchedTasks.has(Number(task.record.id))) {
          this.watchedTasks.add(Number(task.record.id));
          this.ctx.waitUntil(
            pi
              .waitForTask(task.record.id, BG)
              .then(
                () => this.rearm(pi),
                () => {},
              )
              .finally(() => {
                this.watchedTasks.delete(Number(task.record.id));
              }),
          );
        }
    } else await this.ctx.storage.deleteAlarm();
  }
  async alarm() {
    if (!this.manifest) return;
    try {
      await this.arm();
      if (this.deleted) {
        await this.finishDelete();
        return;
      }
      await this.authorize(this.manifest);
      const pi = await this.pi();
      await this.serial(async () => {
        for (const target of [...this.stoppingRoots])
          await this.finishStop(pi, target as ConversationId);
        await this.reconcilePrepared(pi);
        await this.queueEdits(pi).recover();
      });
      await this.rearm(pi);
    } catch (error) {
      if (error instanceof AppError && error.status === 404) {
        this.deleted = true;
        await this.ctx.storage.put('deleting', true);
        await this.ctx.storage.setAlarm(Date.now() + 60_000);
        await this.finishDelete();
        return;
      }
      await this.arm();
      throw error;
    }
  }
  private async deleteChat(actor: ChatActor) {
    if (this.erased) return { deleting: true as const };
    // Commit intent and wake together before D1 hides the chat. A failed local
    // transaction leaves the directory active and an explicit retry possible.
    await this.alarmWork(async () => {
      await this.ctx.storage.transaction(async (tx) => {
        await tx.put('deleting', true);
        await tx.setAlarm(Date.now() + 1000);
      });
      this.deleted = true;
    });
    this.ctx.waitUntil(this.closeForDelete());
    await this.env.DB.prepare(
      "UPDATE conversations SET lifecycle='deleting' WHERE id=? AND owner=? AND instance_generation=? AND lifecycle='active'",
    )
      .bind(actor.chatId, actor.ownerId, actor.generation)
      .run();
    return { deleting: true as const };
  }
  private closeForDelete(): Promise<void> {
    return (this.closingForDelete ??= (async () => {
      await Promise.allSettled([...this.stopJobs.values()]);
      await this.runtime.close();
    })());
  }
  private async finishDelete() {
    const m = this.manifest!;
    await this.closeForDelete();
    // A closed writer cannot lose a newly published confirmation. Read current
    // task metadata with the official storage adapter only; cleanup never starts
    // a Harness, provider or extension tool, including after a cold wake.
    if (m.mainConversationId) {
      const storage = await SqliteStorage.open(new DurableObjectSqliteDatabase(this.ctx.storage), {
        prefix: 'pi_',
      });
      try {
        await drainMcpAcknowledgements(storage, this.env, BG);
      } finally {
        await storage.close(BG);
      }
    }
    await this.env.DB.batch([
      ...[
        'conversation_mcp_bindings',
        'conversation_skill_bindings',
        'conversation_deployment_mcp_bindings',
      ].map((table) =>
        this.env.DB.prepare(`DELETE FROM ${table} WHERE conversation=?`).bind(m.chatId),
      ),
      this.env.DB.prepare(
        "UPDATE conversations SET lifecycle='deleted',title=NULL,title_custom=NULL,created_at=NULL,updated_at=NULL WHERE id=? AND owner=? AND instance_generation=?",
      ).bind(m.chatId, m.ownerId, m.generation),
    ]);
    await this.alarmWork(async () => {
      await this.ctx.storage.deleteAll();
      this.erased = true;
      this.ready = undefined;
      this.manifest = undefined;
    });
  }
  private readContext(target: ConversationId): ReadContext {
    return {
      nativeConversationId: Number(target),
      entries: () => this.activeEntries(target),
      acceptedInputForAnswer: async (answerId) => {
        const entry = await readInputForAnswer(
          await this.pi(),
          target,
          answerId,
          this.runtime.index,
          BG,
        );
        const data = this.inputData(entry);
        return data
          ? {
              text: data.request.text,
              ...(data.request.source ? { source: data.request.source } : {}),
              ...(data.context === undefined ? {} : { context: data.context }),
            }
          : undefined;
      },
      successfulTool: async (ref, name) =>
        readSuccessfulTool(await this.pi(), target, ref, name, BG),
      acceptedInput: async (entryId) => {
        const pi = await this.pi();
        const entry = await this.visibleEntry(pi, target, entryId);
        const data = this.inputData(entry);
        if (!data) return;
        return {
          text: data.request.text,
          ...(data.request.source ? { source: data.request.source } : {}),
          ...(data.context === undefined ? {} : { context: data.context }),
        };
      },
    };
  }
  protected readModel(target: ConversationId) {
    return new ConversationReadModel({
      chatId: this.identity().chatId,
      target,
      pi: () => this.pi(),
      pending: () => this.pending(target),
      queuedInputs: () => this.queuedInputs(target),
      queueEdits: async () => this.queueEdits(await this.pi()).pending(target),
      stopping: () => this.stoppingTargets.has(Number(target)),
      contributions: () => this.contributions(),
      index: this.runtime.index,
      configuration: async () => {
        const modelCatalog = await this.modelCatalog(),
          pi = await this.pi();
        const agent = await pi.snapshot(AgentDoc, target, BG);
        const binding = agent?.model
          ? await pi.snapshot(
              ExecutionBinding,
              bindingKey(agent.model.provider, agent.model.modelId),
              BG,
            )
          : undefined;
        const previous = binding
          ? (JSON.parse(binding.execution) as StoredRequest['execution'])
          : undefined;
        const selection: ModelSelection = previous
          ? {
              provider: previous.provider,
              modelId: previous.modelId,
              thinkingLevel: agent?.thinkingLevel ?? previous.thinkingLevel,
            }
          : modelCatalog.defaultSelection;
        return { modelCatalog, selection, capabilityIssues: [] };
      },
    });
  }
  private resources() {
    return (this.resourceStore ??= new ChatResources({
      database: this.runtime.database,
      contributions: () => this.contributions(),
      readContext: (target) => this.readContext(target),
    }));
  }
  async command(actor: ChatActor, command: ChatCommand): Promise<unknown> {
    try {
      return await this.serial(async () => {
        await this.authorize(actor, command.type === 'delete');
        if (command.type === 'delete') return this.deleteChat(actor);
        this.activeCommands++;
        try {
          const conversation = await this.target(command.target);
          switch (command.type) {
            case 'submit':
              return await this.admit(conversation, command.command);
            case 'stop':
              return await this.stop(conversation);
            case 'queue':
              return await this.queueAction(conversation, command.runId, command.action);
            case 'acknowledge_queue_edit':
              if (!commandSchema.shape.runId.safeParse(command.runId).success)
                throw new AppError(400, 'invalid_request');
              return await this.queueEdits(await this.pi()).acknowledge(
                conversation.id,
                command.runId,
              );
            case 'save_resource_state':
              return await this.resources().save(
                conversation.id,
                command.extensionId,
                command.ref,
                command.state,
                command.expectedRevision,
              );
            case 'extension_control': {
              const controls = (await this.contributions()).find(
                (c) => c.id === command.extensionId,
              )?.controls;
              if (!controls || !Object.hasOwn(controls, command.name))
                throw new AppError(404, 'extension_control_unavailable');
              return await controls[command.name]!.invoke(JSON.parse(command.payload), {
                conversation,
                context: BG,
              });
            }
          }
        } finally {
          this.activeCommands--;
          if (this.ready && !this.deleted) this.ctx.waitUntil(this.rearm(this.ready));
        }
      });
    } catch (error) {
      return errorReply(error);
    }
  }
  async read(actor: ChatActor, query: ChatReadQuery): Promise<unknown> {
    try {
      await this.authorize(actor);
      const conversation = await this.target(query.target);
      switch (query.type) {
        case 'snapshot':
          return JSON.parse(await this.readModel(conversation.id).snapshot());
        case 'history':
          return await this.readModel(conversation.id).readHistory(query.cursor);
        case 'resource':
          return await this.resources().read(conversation.id, query.extensionId, query.ref);
      }
    } catch (error) {
      return errorReply(error);
    }
  }
  async observe(actor: ChatActor, query: ChatObservationQuery): Promise<Response> {
    try {
      await this.authorize(actor);
      const conversation = await this.target(query.target);
      return await this.readModel(conversation.id).observe(query.runId, String(conversation.id));
    } catch (error) {
      const reply = errorReply(error);
      return Response.json(reply, { status: reply.error.status });
    }
  }
}
async function digest(text: string) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}
