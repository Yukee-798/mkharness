import type { AgentEvent, EntryRecord } from '@earendil-works/pi-durable';
import { jsonText, type Json } from './compute';
import { toolRef } from './references';
export type ToolProgress = {
  status: 'pending' | 'running' | 'complete' | 'failed';
  value?: Json;
  truncated?: true;
};
export type ToolProgressMap = Record<string, ToolProgress>;
export type ToolProjector = (value: {
  toolName: string;
  output?: string;
  details?: Json;
  terminal: boolean;
}) => Json;
type Update = Extract<AgentEvent, { type: 'tool_execution_update' }>;
type Slots = Extract<AgentEvent, { type: 'snapshot' }>['tools'];
type Internal = {
  toolName: string;
  output?: string;
  details?: Json;
  status: ToolProgress['status'];
};
export class ToolProgressFold {
  private calls = new Map<string, Internal>();
  private current = new Map<string, string>();
  round(entry: EntryRecord) {
    this.current.clear();
    for (const message of entry.model ?? [])
      if (message.role === 'assistant')
        for (const call of message.content)
          if (call.type === 'toolCall') {
            const id = toolRef(Number(entry.id), call.id);
            this.current.set(call.id, id);
            if (!this.calls.has(id)) this.calls.set(id, { toolName: call.name, status: 'pending' });
          }
  }
  resolve(rawId: string, name: string) {
    const id = this.current.get(rawId);
    return id && this.calls.get(id)?.toolName === name ? id : undefined;
  }
  update(id: string, update: Pick<Update, 'output' | 'details'>) {
    const call = this.calls.get(id);
    if (!call || call.status === 'complete' || call.status === 'failed') return;
    call.status = 'running';
    if (update.output)
      call.output =
        'set' in update.output
          ? update.output.set
          : (call.output ?? '').slice(update.output.trimStart ?? 0) + (update.output.append ?? '');
    if (update.details !== undefined) call.details = update.details as Json;
  }
  end(id: string, success: boolean) {
    const call = this.calls.get(id);
    if (call?.status === 'complete' || call?.status === 'failed') return;
    if (call)
      this.calls.set(id, { toolName: call.toolName, status: success ? 'complete' : 'failed' });
  }
  history(entries: readonly EntryRecord[]) {
    const raw = new Map<string, string>();
    for (const entry of entries)
      for (const message of entry.model ?? []) {
        if (message.role === 'assistant')
          for (const call of message.content) {
            if (call.type !== 'toolCall') continue;
            const id = toolRef(Number(entry.id), call.id);
            raw.set(call.id, id);
            if (!this.calls.has(id)) this.calls.set(id, { toolName: call.name, status: 'pending' });
          }
        if (message.role === 'toolResult') {
          const id = raw.get(message.toolCallId);
          if (id)
            this.calls.set(id, {
              toolName: message.toolName,
              status: message.isError ? 'failed' : 'complete',
            });
        }
      }
  }
  restore(entries: readonly EntryRecord[], slots: Slots, assistant?: number) {
    this.history(entries);
    if (!slots.length) return true;
    const entry = entries.find((entry) => Number(entry.id) === assistant);
    if (!entry) return false;
    this.round(entry);
    if (slots.some((slot) => !this.resolve(slot.callId, slot.name))) return false;
    for (const slot of slots) {
      const id = this.resolve(slot.callId, slot.name)!;
      if (slot.status === 'done')
        this.end(id, slot.entry !== undefined && this.calls.get(id)?.status !== 'failed');
      else {
        const call = this.calls.get(id)!;
        if (call.status === 'complete' || call.status === 'failed') continue;
        this.calls.set(id, {
          toolName: slot.name,
          status: slot.status,
          ...(slot.output === undefined ? {} : { output: slot.output }),
          ...(slot.details === undefined ? {} : { details: slot.details as Json }),
        });
      }
    }
    return true;
  }
  project(projector: (name: string) => ToolProjector | undefined): ToolProgressMap {
    const result: ToolProgressMap = {};
    for (const [id, call] of this.calls) {
      const progress: ToolProgress = { status: call.status };
      if (call.status !== 'complete' && call.status !== 'failed') {
        const project = projector(call.toolName);
        if (project) {
          try {
            const value = project({ ...call, terminal: false });
            jsonText(value, 16300);
            progress.value = value;
          } catch {
            progress.truncated = true;
          }
        }
      }
      result[id] = progress;
    }
    return result;
  }
}
export const projectToolProgress = (
  fold: ToolProgressFold,
  projector: (name: string) => ToolProjector | undefined,
) => fold.project(projector);
