import { ModelCredentials } from '../../src/server/model-credentials';
import { Agent } from 'agents';
import { PiHarness } from 'agents/harness/pi';
import {
  Harness,
  MemoryStorage,
  createRegistry,
  CompactionTask,
  GenerationTask,
  hook,
  AssistantEntry,
  UserEntry,
  type SubmissionExecution,
} from '@earendil-works/pi-durable';
import { Type, createModels } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
const BG = Object.freeze({
  abortSignal: undefined,
  value: () => undefined,
  toString: () => '[Probe]',
});
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
type Binding = { provider: string; modelId: string; thinkingLevel: 'low' | 'high' };
const ref = (v: string): Binding => ({
  provider: 'canary-' + v,
  modelId: v === 'k1' ? 'small' : 'large',
  thinkingLevel: v === 'k1' ? 'high' : 'low',
});
export class BindingProbe extends Agent<any> {
  instanceId = crypto.randomUUID();
  harness: PiHarness;
  catalog: any;
  private probeSettings = {
    followUpMode: 'one-at-a-time' as 'one-at-a-time' | 'all',
    compaction: { reserveTokens: 8000, keepRecentTokens: 4000, backgroundTokens: 10000 },
    retry: { enabled: false, maxRetries: 1, baseDelayMs: 10 },
    stream: { metadata: { probe: 'shared-settings' } },
  };
  gateRelease?: () => void;
  compactRelease?: () => void;
  prepareRelease?: () => void;
  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS probe_log(seq INTEGER PRIMARY KEY AUTOINCREMENT,instance TEXT,event TEXT,data TEXT)',
    );
    this.harness = new PiHarness({
      defaults: { model: { provider: 'canary-k3', id: 'large' } },
      harness: async ({ storage, context }) => {
        const models = createModels({
          authContext: {
            env: async () => {
              throw new Error('ambient auth forbidden');
            },
            fileExists: async () => false,
          },
        });
        for (const version of ['k1', 'k2', 'k3']) {
          const b = ref(version);
          const stream = (model: any, context: any, options: any) =>
            this.providerStream(version, model, context, options);
          models.setProvider({
            id: b.provider,
            name: b.provider,
            auth: {
              apiKey: {
                name: 'canary',
                resolve: async () => {
                  const binding = await ctx.storage.get<{
                    owner: string;
                    refs: Record<string, import('../../src/shared/model-settings').CredentialRef>;
                  }>('d1-credentials');
                  if (binding)
                    return {
                      auth: {
                        apiKey: await new ModelCredentials(this.env, binding.owner).resolve(
                          'fixture',
                          binding.refs[version],
                        ),
                      },
                      source: version,
                    };
                  const disabled = (await ctx.storage.get<string[]>('disabled')) ?? [];
                  if (disabled.includes(version))
                    throw new Error('credential_version_missing:' + version);
                  return { auth: { apiKey: 'CANARY-NONSECRET-' + version }, source: version };
                },
              },
            },
            getModels: () => [
              {
                provider: b.provider,
                id: b.modelId,
                name: b.modelId,
                api: 'openai-responses',
                baseUrl: 'https://fixture.invalid',
                reasoning: true,
                thinkingLevelMap: { low: 'low', high: 'high' },
                input: ['text'],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: version === 'k1' ? 32000 : 100000,
                maxTokens: 4000,
              },
            ],
            stream,
            streamSimple: stream,
          });
        }
        this.catalog = models;
        const registry = createRegistry();
        registry.install({
          name: 'probe',
          tools: [
            {
              name: 'pause_tool',
              description: 'Probe public tool seam',
              parameters: Type.Object({}),
              replay: 'safe',
              execute: async (_args, _api, context) => {
                this.log('tool-enter', {});
                if (!(await ctx.storage.get('release-tool'))) await this.waitGate('tool', context);
                this.log('tool-done', {});
                return { content: [{ type: 'text', text: 'tool complete' }] };
              },
            },
          ],
          sections: [
            {
              key: 'probe',
              render: async (input, context) => {
                this.log('prepare-agent', {
                  model: input.agent.model,
                  thinking: input.agent.thinkingLevel,
                });
                if (await ctx.storage.get('gate-prepare')) await this.waitGate('prepare', context);
                return undefined;
              },
            },
          ],
          hooks: [
            hook(GenerationTask, {
              onYield: (message) =>
                message.content.some(
                  (part) => part.type === 'text' && part.text === 'answer yield-A',
                )
                  ? { continue: 'yield-next' }
                  : undefined,
            }),
            hook(CompactionTask, {
              beforeCompact: async (input, api, context) => {
                this.log('compact-selected', { taskId: api.taskId, reason: input.reason });
                if (await ctx.storage.get('gate-compact')) await this.waitGate('compact', context);
              },
            }),
          ],
        });
        return Harness.open(
          storage,
          {
            models,
            registry,
            settings: this.probeSettings,
            onReport: (error) => this.log('report', { message: String(error) }),
          },
          context,
        );
      },
    });
    this.lifecycle.use(this.harness);
  }
  log(event: string, data: any) {
    this.ctx.storage.sql.exec(
      'INSERT INTO probe_log(instance,event,data)VALUES(?,?,?)',
      this.instanceId,
      event,
      JSON.stringify(data),
    );
  }
  async waitGate(which: 'tool' | 'compact' | 'prepare', context: any) {
    await new Promise<void>((resolve) => {
      if (which === 'tool') this.gateRelease = resolve;
      else if (which === 'compact') this.compactRelease = resolve;
      else this.prepareRelease = resolve;
      if (context.abortSignal?.aborted) resolve();
      else context.abortSignal?.addEventListener('abort', resolve, { once: true });
    });
  }
  providerStream(version: string, model: any, context: any, options: any) {
    const summary = context.messages.some(
      (m: any) =>
        m.role === 'system' &&
        typeof m.content === 'string' &&
        m.content.includes('summarization assistant'),
    );
    const user = context.messages.findLast((m: any) => m.role === 'user');
    const text = typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content);
    const tool =
      !summary &&
      text?.includes('tool-A') &&
      !context.messages.some((m: any) => m.role === 'toolResult' && m.toolName === 'pause_tool');
    this.log('provider', {
      version,
      provider: model.provider,
      model: model.id,
      contextWindow: model.contextWindow,
      thinking: options.reasoning ?? 'off',
      keyMatches: options.apiKey === 'CANARY-NONSECRET-' + version,
      sessionId: options.sessionId,
      metadata: options.metadata,
      summary,
      user: summary ? 'summary' : text,
    });
    const attempt = Number(
      this.ctx.storage.sql
        .exec(
          "SELECT COUNT(*) AS n FROM probe_log WHERE event='provider' AND json_extract(data,'$.user')=?",
          text ?? '',
        )
        .one().n,
    );
    const injected =
      !summary && attempt === 1 && text?.includes('retry-A')
        ? '429 rate limit'
        : !summary && attempt === 1 && text?.includes('overflow-A')
          ? 'maximum context length exceeded'
          : undefined;
    const events = new AssistantMessageEventStream();
    const message: any = {
      role: 'assistant',
      content: tool
        ? [{ type: 'toolCall', id: 'same-call', name: 'pause_tool', arguments: {} }]
        : [{ type: 'text', text: summary ? 'summary result' : 'answer ' + text }],
      provider: model.provider,
      model: model.id,
      api: model.api,
      thinkingLevel: options.reasoning ?? 'off',
      usage,
      stopReason: tool ? 'toolUse' : injected || text?.includes('error-A') ? 'error' : 'stop',
      ...(text?.includes('error-A') && !tool
        ? { errorMessage: 'fatal fixture credential error' }
        : {}),
      ...(injected ? { errorMessage: injected } : {}),
      timestamp: Date.now(),
    };
    events.push({ type: 'start', partial: { ...message, content: [] } });
    const done = () => {
      if (message.stopReason === 'error')
        events.push({ type: 'error', reason: 'error', error: message });
      else events.push({ type: 'done', reason: tool ? 'toolUse' : 'stop', message });
      events.end(message);
    };
    setTimeout(done, 15);
    return events;
  }
  async useD1Credentials(
    owner: string,
    refs: Record<string, import('../../src/shared/model-settings').CredentialRef>,
  ) {
    await this.ctx.storage.put('d1-credentials', { owner, refs });
  }
  async configure(b: Binding) {
    const pi = await this.harness.pi();
    const root = await pi.root(BG);
    await root.configure(
      { model: { provider: b.provider, modelId: b.modelId }, thinkingLevel: b.thinkingLevel },
      BG,
    );
  }
  async set(version: string) {
    await this.configure(ref(version));
  }
  async mode(name: string, value = true) {
    if (name === 'retry-enabled') this.probeSettings.retry.enabled = value;
    if (name === 'all-followups') this.probeSettings.followUpMode = value ? 'all' : 'one-at-a-time';
    await this.ctx.storage.put(name, value);
  }
  async submit(id: string, text: string, version: string, setModel = false) {
    const bindings = (await this.ctx.storage.get<Record<string, Binding>>('bindings')) ?? {};
    if (!bindings[id]) {
      bindings[id] = ref(version);
      await this.ctx.storage.put('bindings', bindings);
    }
    if (setModel) await this.configure(bindings[id]);
    const b = bindings[id];
    const execution: SubmissionExecution = {
      model: { provider: b.provider, modelId: b.modelId },
      thinkingLevel: b.thinkingLevel,
    };
    return this.harness.submit(text, {
      operationId: id,
      whenBusy: 'followUp',
      execution,
    });
  }
  async submitDraft(draft: any) {
    const root = await (await this.harness.pi()).root(BG);
    try {
      return { id: (await root.submit(draft, BG)).id };
    } catch (error) {
      // Return expected validation failures from this RPC test facade, as the app API does.
      return { error: (error as Error).message };
    }
  }
  async release(which: 'tool' | 'compact') {
    if (which === 'tool') {
      await this.ctx.storage.put('release-tool', true);
      this.gateRelease?.();
    } else {
      await this.ctx.storage.put('gate-compact', false);
      this.compactRelease?.();
    }
  }
  async seed(size = 100000) {
    const pi = await this.harness.pi();
    const root = await pi.root(BG);
    await root.commit(async (tx) => {
      const user = {
        role: 'user' as const,
        content: 'previous large context',
        timestamp: Date.now(),
      };
      await tx.appendEntry(UserEntry, root.id, { model: [user] });
      await tx.appendEntry(AssistantEntry, root.id, {
        model: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'x'.repeat(size) }],
            api: 'openai-responses',
            provider: 'canary-k1',
            model: 'small',
            thinkingLevel: 'high',
            usage: { ...usage, output: Math.ceil(size / 4), totalTokens: Math.ceil(size / 4) },
            stopReason: 'stop',
            timestamp: Date.now(),
          },
        ],
      });
      await tx.appendEntry(UserEntry, root.id, {
        model: [{ role: 'user', content: 'recent', timestamp: Date.now() }],
      });
      await tx.appendEntry(AssistantEntry, root.id, {
        model: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'recent answer' }],
            api: 'openai-responses',
            provider: 'canary-k1',
            model: 'small',
            thinkingLevel: 'high',
            usage,
            stopReason: 'stop',
            timestamp: Date.now(),
          },
        ],
      });
    }, BG);
  }
  async compact(version = 'k1') {
    const pi = await this.harness.pi();
    const root = await pi.root(BG);
    const b = ref(version);
    return root.compact('probe manual', BG, {
      execution: {
        model: { provider: b.provider, modelId: b.modelId },
        thinkingLevel: b.thinkingLevel,
      },
    });
  }
  async stop() {
    return this.harness.abort();
  }
  async operation(id: string) {
    return this.harness.wait(id);
  }
  async nativePausedCompaction() {
    await this.harness.pi();
    const pi = await Harness.open(
      new MemoryStorage(),
      {
        models: this.catalog,
        registry: createRegistry(),
        settings: {
          compaction: { reserveTokens: 8000, keepRecentTokens: 4000, backgroundTokens: 10000 },
        },
      },
      BG,
    );
    const root = await pi.root(BG, {
      agent: { model: { provider: 'canary-k1', modelId: 'small' }, thinkingLevel: 'high' },
    });
    await root.commit(async (tx) => {
      await tx.appendEntry(UserEntry, root.id, {
        model: [{ role: 'user', content: 'old', timestamp: Date.now() }],
      });
      await tx.appendEntry(AssistantEntry, root.id, {
        model: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'x'.repeat(100000) }],
            api: 'openai-responses',
            provider: 'canary-k1',
            model: 'small',
            thinkingLevel: 'high',
            usage: { ...usage, output: 25000, totalTokens: 25000 },
            stopReason: 'stop',
            timestamp: Date.now(),
          },
        ],
      });
      await tx.appendEntry(UserEntry, root.id, {
        model: [{ role: 'user', content: 'recent', timestamp: Date.now() }],
      });
    }, BG);
    const id = await root.commit(
      (tx) =>
        tx.createTask(
          CompactionTask,
          {
            reason: 'manual',
            execution: {
              model: { provider: 'canary-k1', modelId: 'small' },
              thinkingLevel: 'high',
            },
          },
          { ownership: { kind: 'conversation' }, background: true },
        ),
      BG,
    );
    const before = await pi.getTask(id, BG);
    await root.configure(
      { model: { provider: 'canary-k2', modelId: 'large' }, thinkingLevel: 'low' },
      BG,
    );
    pi.resume();
    await pi.waitForTask(id, BG);
    await pi.close(BG);
    return before;
  }
  async resume() {
    (await this.harness.pi()).resume();
  }
  async persistedHasCanary() {
    const names = this.ctx.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'pi_%'")
      .toArray()
      .map((r) => String(r.name));
    return names.some((name) =>
      JSON.stringify(
        this.ctx.storage.sql
          .exec('SELECT * FROM ' + name)
          .toArray()
          .map((row) =>
            Object.fromEntries(
              Object.entries(row).map(([k, v]) => [
                k,
                v instanceof ArrayBuffer
                  ? new TextDecoder().decode(v)
                  : ArrayBuffer.isView(v)
                    ? new TextDecoder().decode(v as unknown as Uint8Array)
                    : v,
              ]),
            ),
          ),
      ).includes('CANARY-NONSECRET-'),
    );
  }
  async disable(version: string) {
    await this.ctx.storage.put('disabled', [version]);
  }
  async observation() {
    const pi = await this.harness.pi();
    const inspect = await pi.inspect(BG);
    return {
      instanceId: this.instanceId,
      log: this.ctx.storage.sql
        .exec('SELECT instance,event,data FROM probe_log ORDER BY seq')
        .toArray()
        .map((r) => ({ ...r, data: JSON.parse(String(r.data)) })),
      pending: await this.harness.pending(),
      tasks: inspect.tasks.map((t) => t.record),
      submissions: inspect.submissions,
    };
  }
}
export default { fetch: () => new Response('isolated model binding probe') };
