import { env as bindings, runInDurableObject as runNative } from 'cloudflare:test';
import type { ChatSession } from './entry';
import type { LifecycleProbe } from './lifecycle-entry';
import type { BYOKProbe } from './byok-entry';
import type { OpenRouterProbe } from './openrouter-entry';
import type { ImageProbe } from './image-entry';
import type { RunCommand } from '../../src/shared/contracts';

// RPC exposes serializable operations. Native handles are available only to a
// local runInDurableObject callback, never recursively mapped into RPC proxies.
declare const localFixture: unique symbol;
type FixtureReply = {
  accepted?: boolean;
  runId?: string;
  revision?: number;
  error?: { status: number; code: string; message?: string };
};
type RpcFixture<T extends Rpc.DurableObjectBranded> = Omit<
  T,
  'root' | 'harness' | 'allEntries' | 'history' | 'submission' | 'submitRun' | 'saveResourceState'
> & {
  submitRun(command: RunCommand): Promise<FixtureReply>;
  submission(runId: string): Promise<{ id: number; status: string; reason?: string } | undefined>;
  saveResourceState(
    extensionId: string,
    ref: string,
    state: unknown,
    expectedRevision: number,
  ): Promise<FixtureReply>;
};
type LocalFixture<T extends Rpc.DurableObjectBranded> = T;
type FixtureRpc = RpcFixture<ChatSession> &
  Pick<ImageProbe, 'imageProbe'> &
  Pick<LifecycleProbe, 'probe'> &
  Pick<BYOKProbe, 'calls' | 'compactions'>;
type FixtureStub<T extends Rpc.DurableObjectBranded> = DurableObjectStub<FixtureRpc> & {
  readonly [localFixture]: T;
};
type FixtureNamespace<T extends Rpc.DurableObjectBranded> = Omit<
  DurableObjectNamespace<FixtureRpc>,
  'get' | 'getByName'
> & {
  get(id: DurableObjectId, options?: DurableObjectNamespaceGetDurableObjectOptions): FixtureStub<T>;
  getByName(name: string, options?: DurableObjectNamespaceGetDurableObjectOptions): FixtureStub<T>;
};
export const env = bindings as unknown as Omit<
  Env,
  'CONVERSATIONS' | 'LIFECYCLE_PROBES' | 'BYOK_PROBES' | 'OPENROUTER_PROBES'
> & {
  IMAGE_PROBES: FixtureNamespace<ImageProbe>;
  CONVERSATIONS: FixtureNamespace<ChatSession>;
  LIFECYCLE_PROBES: FixtureNamespace<LifecycleProbe>;
  BYOK_PROBES: FixtureNamespace<BYOKProbe>;
  OPENROUTER_PROBES: FixtureNamespace<OpenRouterProbe>;
};

export function runInDurableObject<T extends Rpc.DurableObjectBranded, R>(
  stub: FixtureStub<T>,
  callback: (instance: LocalFixture<T>, state: DurableObjectState) => R,
): Promise<Awaited<R>> {
  // The configured namespace determines the local class; the phantom tag never crosses RPC.
  return runNative(
    stub as DurableObjectStub<Rpc.DurableObjectBranded>,
    callback as unknown as (instance: Rpc.DurableObjectBranded, state: DurableObjectState) => R,
  ) as Promise<Awaited<R>>;
}
