import type { Json } from '../../../shared/json';
import { canonicalJson, finiteJson, jsonEqual } from '../../../shared/json';
import type { RawState } from '../../../shared/contracts';
import type { Program, ComputeResult } from '../compute/contracts';
import { inputState } from '../state';

type Options = {
  program?: Program | null;
  initialState?: RawState;
  compute?: (program: Program, inputs: Json, signal: AbortSignal) => Promise<ComputeResult>;
  save?: { update: (state: RawState) => void };
  report: (message: string) => void;
  userCommitted?: () => void;
};
/** Owns input epochs, computation provenance and each binding's automatic-write chain. */
export class PanelSession {
  private state: RawState;
  private epoch = 0;
  private live = true;
  private failed = false;
  private active = new Set<AbortController>();
  private provenance = new WeakMap<object, string>();
  private chains = new WeakMap<object, { epoch: number; writes: number; halted: boolean }>();
  private listeners = new Set<() => void>();
  private snapshot = { ready: true, version: 0 };
  constructor(private options: Options) {
    this.state = inputState(options.initialState ?? {});
    this.snapshot = { ready: !options.program, version: 0 };
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.live = true;
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.dispose();
    };
  };
  private publish() {
    this.snapshot = {
      ready: this.live && (!this.options.program || (this.active.size === 0 && !this.failed)),
      version: this.snapshot.version + 1,
    };
    for (const listener of this.listeners) listener();
  }
  current() {
    return this.state;
  }
  markUserCommit = () => {
    this.options.userCommitted?.();
    this.epoch++;
    for (const controller of this.active) controller.abort();
    this.failed = false;
    this.options.report('');
    this.publish();
  };
  change = (raw: Record<string, unknown>, user = false) => {
    try {
      const next = inputState(raw);
      if (user && !jsonEqual(next, this.state)) this.markUserCommit();
      this.state = next;
      this.options.save?.update(next);
      this.publish();
    } catch {
      this.options.report('Input state cannot be saved as finite JSON');
    }
  };
  captureBinding = (key: string, value: unknown) => this.change({ ...this.state, [key]: value });
  run = async (inputs: Record<string, unknown>) => {
    finiteJson(inputs);
    const inputSnapshot = structuredClone(inputs);
    const inputKey = canonicalJson(inputSnapshot);
    if (!this.live || !this.options.program || !this.options.compute)
      throw new Error('Calculation unavailable');
    const controller = new AbortController(),
      epoch = this.epoch;
    this.active.add(controller);
    this.failed = false;
    this.publish();
    try {
      const result = await this.options.compute(
        this.options.program,
        inputSnapshot as Json,
        controller.signal,
      );
      if (!this.live || controller.signal.aborted || epoch !== this.epoch)
        throw new Error('Stale computation discarded');
      if (!result.ok) {
        this.failed = true;
        this.options.report(result.error.message);
        throw new Error(result.error.message);
      }
      if (result.value && typeof result.value === 'object')
        this.provenance.set(result.value, inputKey);
      return result.value;
    } finally {
      this.active.delete(controller);
      if (this.live) this.publish();
    }
  };
  automaticWrite(binding: object, current: unknown, next: unknown, frame?: unknown) {
    if (!this.snapshot.ready) return false;
    let chain = this.chains.get(binding);
    if (!chain || chain.epoch !== this.epoch) {
      chain = { epoch: this.epoch, writes: 0, halted: false };
      this.chains.set(binding, chain);
    }
    if (chain.halted) return false;
    if (this.options.program) {
      if (!frame || typeof frame !== 'object') return false;
      const f = frame as { result: unknown; inputs: unknown };
      try {
        if (
          !f.result ||
          typeof f.result !== 'object' ||
          this.provenance.get(f.result) !== canonicalJson(f.inputs)
        )
          return false;
      } catch {
        return false;
      }
    }
    try {
      finiteJson(next);
    } catch {
      this.options.report('Automatic update is not finite JSON');
      return false;
    }
    if (current !== undefined && jsonEqual(current, next)) return false;
    if (chain.writes >= 3) {
      chain.halted = true;
      this.options.report('Automatic input updates did not converge. Edit an input to retry.');
      return false;
    }
    chain.writes++;
    return true;
  }
  dispose() {
    if (!this.live) return;
    this.live = false;
    this.epoch++;
    for (const controller of this.active) controller.abort();
    this.snapshot = { ready: false, version: this.snapshot.version + 1 };
  }
}
