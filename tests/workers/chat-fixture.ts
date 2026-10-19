import { ChatSession as Production } from '../../src/server/chat/session-object';
import { BG } from '../../src/server/chat/context';
import type { ChatActor } from '../../src/server/chat/protocol';
import type { RunCommand, StoredRequest } from '../../src/shared/contracts';
import type { QueueAction } from '../../src/shared/queue';
import type { Json } from '../../src/shared/json';
import {
  AgentDoc,
  type Cursor,
  type Harness,
  type ConversationId,
  type Conversation,
} from '@earendil-works/pi-durable';
import { ExecutionBinding, bindingKey } from '../../src/server/chat/documents';

/** Inspect native configuration and its immutable binding at admission time. */
export async function configuredExecution(pi: Harness, conversationId: ConversationId) {
  const ref = (await pi.snapshot(AgentDoc, conversationId, BG))?.model;
  if (!ref) throw new Error('Missing native model configuration');
  const binding = await pi.snapshot(ExecutionBinding, bindingKey(ref.provider, ref.modelId), BG);
  if (!binding) throw new Error('Missing immutable execution binding');
  return { ref, execution: JSON.parse(binding.execution) as StoredRequest['execution'] };
}

/** Test conveniences call the production command/read protocol; none is shipped by the application. */
export class ChatFixture extends Production {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, {
      ...env,
      CONVERSATIONS: new Proxy(env.CONVERSATIONS, {
        get(target, key) {
          if (key === 'idFromName') return () => ctx.id;
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    });
  }
  async actor(): Promise<ChatActor> {
    const stored = await this.ctx.storage.get<ChatActor>('manifest');
    const locator = this.ctx.id.name;
    const located = locator
      ? await this.env.DB.prepare(
          'SELECT main_chat_id FROM scenario_instances WHERE runtime_name=?',
        )
          .bind(locator)
          .first<string>('main_chat_id')
      : undefined;
    const id = stored?.chatId ?? located ?? locator;
    if (!id) throw new Error('Tests must use getByName');
    let row = await this.env.DB.prepare(
      'SELECT owner,instance_generation FROM conversations WHERE id=?',
    )
      .bind(id)
      .first<{ owner: string; instance_generation: string }>();
    if (!row) {
      const owner = 'fixture-' + id,
        now = Date.now();
      await this.env.DB.prepare(
        'INSERT OR IGNORE INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)',
      )
        .bind(owner, 'Fixture', owner + '@example.test', 1, now, now)
        .run();
      await this.env.DB.prepare(
        'INSERT OR IGNORE INTO conversations(id,owner,create_request_id,create_hash,instance_generation,title,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      )
        .bind(id, owner, crypto.randomUUID(), 'fixture', crypto.randomUUID(), '新聊天', now, now)
        .run();
      row = await this.env.DB.prepare(
        'SELECT owner,instance_generation FROM conversations WHERE id=?',
      )
        .bind(id)
        .first<{ owner: string; instance_generation: string }>();
    }
    const { resolveChat, directoryActor } = await import('../../src/server/chat/directory');
    return directoryActor(await resolveChat(this.env, row!.owner, id, true));
  }
  protected override async credentials(): Promise<
    import('../../src/server/models/execution').CredentialAccess
  > {
    return {
      select: async () => ({ source: 'server' as const, fingerprint: 'fixture-only' }),
      resolve: async () => ({ apiKey: 'fixture' }),
    };
  }
  protected override async contributions() {
    await this.authorize(await this.actor());
    return super.contributions();
  }
  async root(): Promise<Conversation> {
    const actor = await this.actor();
    await this.read(actor, { type: 'snapshot' });
    return this.target();
  }
  async submitRun(command: RunCommand): Promise<any> {
    return this.command(await this.actor(), { type: 'submit', command });
  }
  async snapshot(_cursor?: unknown, _window?: boolean) {
    return JSON.stringify(await this.read(await this.actor(), { type: 'snapshot' }));
  }
  async readHistory(cursor?: string) {
    return JSON.stringify(await this.read(await this.actor(), { type: 'history', cursor }));
  }
  async observeRun(runId: string, _thread?: string, _window?: boolean) {
    return this.observe(await this.actor(), { runId });
  }
  async stopConversation() {
    return this.command(await this.actor(), { type: 'stop' });
  }
  async deleteConversation(_id?: string) {
    return this.command(await this.actor(), { type: 'delete' });
  }
  async actOnQueuedInput(runId: string, action: QueueAction) {
    return JSON.stringify(await this.command(await this.actor(), { type: 'queue', runId, action }));
  }
  async controlExtension(extensionId: string, name: string, payload: string) {
    const reply = await this.command(await this.actor(), {
      type: 'extension_control',
      extensionId,
      name,
      payload,
    });
    return reply && typeof reply === 'object' && 'error' in reply
      ? { ok: false, ...(reply.error as object) }
      : { ok: true, value: JSON.stringify(reply) };
  }
  async loadResource(extensionId: string, ref: string) {
    return JSON.stringify(
      await this.read(await this.actor(), { type: 'resource', extensionId, ref }),
    );
  }
  async saveResourceState(
    extensionId: string,
    ref: string,
    state: unknown,
    expectedRevision: number,
  ): Promise<any> {
    return this.command(await this.actor(), {
      type: 'save_resource_state',
      extensionId,
      ref,
      state: state as Json,
      expectedRevision,
    });
  }
  override async queuedInputs(target?: ConversationId) {
    return super.queuedInputs(target ?? (await this.root()).id);
  }
  async allEntries() {
    return (await this.root()).context(BG).then((v) => [...v.entries]);
  }
  async history(cursor?: Cursor) {
    return (await this.root()).entries({ order: 'ascending' }, 100, cursor, BG);
  }
  async submission(runId: string) {
    const root = await this.root();
    return root.commit((tx) => tx.submissionByRequest(root.id, runId), BG);
  }
  readonly harness: {
    pi: () => Promise<Harness>;
    pending: (options?: unknown) => Promise<any[]>;
    submit: (
      content: import('@earendil-works/pi-durable').UserInput,
      options: {
        operationId: string;
        session?: string;
        whenBusy?: 'steer' | 'followUp' | 'reject';
      },
    ) => Promise<any>;
    dispose: () => Promise<void>;
  } = {
    pi: async () => {
      await this.root();
      return this.pi();
    },
    pending: async (_options?: unknown) => {
      const root = await this.root();
      return this.pending(root.id);
    },
    submit: async (
      content: import('@earendil-works/pi-durable').UserInput,
      options: {
        operationId: string;
        session?: string;
        whenBusy?: 'steer' | 'followUp' | 'reject';
      },
    ) =>
      (await this.root()).submit(
        { type: 'input', content, requestId: options.operationId, whenBusy: options.whenBusy },
        BG,
      ),
    dispose: async () => {
      await (await this.pi()).close(BG);
    },
  };
}
