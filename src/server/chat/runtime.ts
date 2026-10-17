import {
  Harness,
  ProviderDoc,
  createRegistry,
  createSession,
  type Extension,
} from '@earendil-works/pi-durable';
import type { Models } from '@earendil-works/pi-ai/models';
import { openChatStorage } from './storage';
import { BG } from './context';
import { ModelTarget } from './documents';
import { createConversationPolicy, type RuntimePolicy } from './policy';
import { guardTools } from '../limits';

/** Owns exactly one native Harness. Opening is paused; only its host authorizes progress. */
export class ChatRuntime {
  private opening?: Promise<Harness>;
  private closing?: Promise<void>;
  private current?: Harness;
  private data?: Awaited<ReturnType<typeof openChatStorage>>;
  private sealed = false;
  constructor(private host: DurableObjectState) {}
  get index() {
    if (!this.data) throw new Error('Runtime is not open');
    return this.data.index;
  }
  get database() {
    if (!this.data) throw new Error('Runtime is not open');
    return this.data.database;
  }
  open(options: {
    models: Models;
    extensions: readonly Extension[];
    policy?: RuntimePolicy;
    restore: (session: ReturnType<typeof createSession>) => Promise<void>;
    committed: () => void;
  }): Promise<Harness> {
    if (this.sealed) return Promise.reject(new Error('Runtime is closed'));
    return (this.opening ??= (async () => {
      try {
        this.data = await openChatStorage(this.host.storage);
        const bootstrap = createSession(this.data.storage, { documentRetentionMs: 0 });
        await options.restore(bootstrap);
        const registry = createRegistry();
        for (const extension of options.extensions)
          registry.install(guardTools(extension, async () => this.current!));
        const pi = await Harness.open(
          this.data.storage,
          {
            models: options.models,
            registry,
            settings: {
              followUpMode: 'one-at-a-time',
              steeringMode: 'one-at-a-time',
              toolExecution: 'sequential',
              contextRetentionMs: 0,
              documentRetentionMs: 0,
            },
            conversationCreated: async (tx, conversation) => {
              await createConversationPolicy(tx, conversation, options.policy);
              const provider = await tx.doc(ProviderDoc, conversation.id);
              await tx.doc(ModelTarget, provider.sessionId, {
                conversationId: Number(conversation.id),
              });
            },
            onReport: () => console.error(JSON.stringify({ stage: 'pi', error: 'runtime_report' })),
          },
          BG,
        );
        this.current = pi;
        const unsubscribe = pi.subscribeCommits(options.committed);
        pi.subscribeClose(unsubscribe);
        this.host.waitUntil(
          pi.closed.then((end) => {
            if (end.reason !== 'closed') {
              this.sealed = true;
              // A failed native storage runtime is unusable. Eviction gives the next invocation a clean instance.
              this.host.abort('Native runtime storage failed');
            }
          }),
        );
        return pi;
      } catch (error) {
        this.sealed = true;
        // Opening can fail before a Harness exists to publish `closed`. Drain
        // its storage before eviction, and preserve the original factory error.
        try {
          await this.data?.storage.close(BG);
        } catch {
          /* The failed storage is sealed. */
        }
        this.host.abort('Native runtime initialization failed');
        throw error;
      }
    })());
  }
  close(): Promise<void> {
    this.sealed = true;
    return (this.closing ??= (async () => {
      // A rejected factory already sealed and drained storage. It must not
      // prevent the host's durable deletion cleanup from completing.
      const pi =
        this.current ?? (this.opening ? await this.opening.catch(() => undefined) : undefined);
      if (pi) await pi.close(BG);
    })());
  }
}
