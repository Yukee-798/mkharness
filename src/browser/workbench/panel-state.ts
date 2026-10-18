import { jsonEqual, jsonText, type Json } from '../../shared/json';
import type {
  OpenPanelResult,
  PanelRequest,
  PanelSelection,
  WorkbenchPanelDefinition,
} from './panels';

type Memory = { active: PanelSelection | null; hidden: boolean };
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
export class WorkbenchPanels {
  private definitions: ReadonlyMap<string, WorkbenchPanelDefinition> = new Map();
  private memories = new Map<string, Memory>();
  private chatId = '';
  private workspaceSelected = false;
  private seen = new Set<string>();
  private listeners = new Set<() => void>();
  private value = {
    active: null as PanelSelection | null,
    latest: null as PanelSelection | null,
    hidden: false,
    maximized: false,
    width: 45,
    pageVisible: true,
  };
  private storageKey: string;
  constructor(
    userId: string,
    private storage?: StoragePort,
  ) {
    this.storageKey = `mkharness.workbench.${userId}`;
    try {
      const raw = storage?.getItem(this.storageKey);
      if (raw && raw.length <= 65536) {
        const saved = JSON.parse(raw);
        this.workspaceSelected = saved.workspaceSelected === true;
        if (Number.isFinite(saved.width))
          this.value.width = Math.min(70, Math.max(30, saved.width));
        if (Array.isArray(saved.memories))
          for (const item of saved.memories.slice(-32))
            if (
              Array.isArray(item) &&
              typeof item[0] === 'string' &&
              item[1]?.active &&
              typeof item[1].active.type === 'string'
            )
              this.memories.set(item[0], {
                active: item[1].active,
                hidden: item[1].hidden === true,
              });
      }
    } catch {
      /* Layout storage is optional. */
    }
  }
  getSnapshot = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  definition(type: string) {
    return this.definitions.get(type);
  }
  private emit(patch: Partial<typeof this.value>) {
    this.value = { ...this.value, ...patch };
    for (const listener of this.listeners) listener();
  }
  private persist() {
    try {
      const memories = [...this.memories].slice(-32).flatMap(([key, memory]) => {
        const active = memory.active;
        if (!active) return [];
        const definition = this.definitions.get(active.type);
        const target = definition?.restore?.(active.target);
        if (!definition || target == null) return [];
        const parsed = definition.parse(target);
        return [
          [
            key,
            {
              hidden: memory.hidden,
              active: { ...active, target: parsed, key: definition.key(parsed) },
            },
          ],
        ];
      });
      this.storage?.setItem(
        this.storageKey,
        jsonText(
          { memories, width: this.value.width, workspaceSelected: this.workspaceSelected },
          65536,
        ),
      );
    } catch {
      /* A failed layout save never affects the resource or conversation. */
    }
  }
  setDefinitions(definitions: ReadonlyMap<string, WorkbenchPanelDefinition>) {
    if (this.definitions === definitions) return;
    this.definitions = definitions;
    for (const [key, memory] of this.memories) {
      const active = memory.active;
      const definition = active && definitions.get(active.type);
      if (!active || !definition) continue;
      try {
        const target = definition.parse(active.target);
        jsonText(target);
        if ((definition.scope === 'workspace') !== (key === 'workspace'))
          throw new Error('Invalid scope');
        memory.active = {
          type: active.type,
          target,
          key: definition.key(target),
          chatId: key === 'workspace' ? null : key,
        };
      } catch {
        this.memories.delete(key);
      }
    }
    const memory = this.memories.get(this.workspaceSelected ? 'workspace' : this.chatId);
    this.emit({ active: memory?.active ?? null, hidden: memory?.hidden ?? false });
  }
  selectChat(chatId: string) {
    if (this.chatId === chatId) return;
    this.chatId = chatId;
    const memory = this.memories.get(this.workspaceSelected ? 'workspace' : chatId);
    this.emit({
      active: memory?.active ?? null,
      hidden: memory?.hidden ?? false,
      latest: null,
      maximized: false,
    });
  }
  private resolve(request: PanelRequest): PanelSelection | OpenPanelResult {
    const definition = this.definitions.get(request.type);
    if (!definition) return { ok: false, reason: 'unavailable' };
    if (definition.scope === 'conversation' && !this.chatId)
      return { ok: false, reason: 'conversation_required' };
    try {
      const target = definition.parse(request.target);
      jsonText(target);
      const key = definition.key(target);
      if (!key || key.length > 1024) throw new Error('Invalid panel key');
      return {
        type: request.type,
        target,
        key,
        chatId: definition.scope === 'conversation' ? this.chatId : null,
      };
    } catch {
      return { ok: false, reason: 'invalid_target' };
    }
  }
  openPanel = (request: PanelRequest): OpenPanelResult => {
    const selection = this.resolve(request);
    if ('ok' in selection) return selection;
    const identity = JSON.stringify([selection.chatId, selection.type, selection.key]);
    if (request.activation === 'suggested') {
      if (this.seen.has(identity)) return { ok: true };
      this.seen.add(identity);
      if (this.seen.size > 256) this.seen.delete(this.seen.values().next().value!);
      if (this.value.active || this.value.hidden) {
        this.emit({ latest: selection });
        return { ok: true };
      }
    }
    this.workspaceSelected = selection.chatId === null;
    this.memories.delete(selection.chatId ?? 'workspace');
    this.memories.set(selection.chatId ?? 'workspace', { active: selection, hidden: false });
    if (this.memories.size > 32) this.memories.delete(this.memories.keys().next().value!);
    this.emit({ active: selection, hidden: false, latest: null });
    this.persist();
    return { ok: true };
  };
  /** Live updates change an already selected resource without activating another one. */
  updatePanel = (type: string, target: Json) => {
    const selection = this.resolve({ type, target, activation: 'suggested' });
    if ('ok' in selection) return;
    const same = (other: PanelSelection | null) =>
      other?.type === type && other.key === selection.key && other.chatId === selection.chatId;
    if (same(this.value.active) && !jsonEqual(this.value.active!.target, selection.target)) {
      this.memories.set(selection.chatId ?? 'workspace', {
        active: selection,
        hidden: this.value.hidden,
      });
      this.emit({ active: selection });
      this.persist();
    } else if (same(this.value.latest) && !jsonEqual(this.value.latest!.target, selection.target))
      this.emit({ latest: selection });
  };
  hidePanel = () => {
    const active = this.value.active;
    this.memories.set(active?.chatId ?? (active ? 'workspace' : this.chatId), {
      active,
      hidden: true,
    });
    this.emit({ hidden: true, maximized: false });
    this.persist();
  };
  showPanel = () => {
    if (this.value.active) this.openPanel({ ...this.value.active, activation: 'explicit' });
  };
  toggleMaximized = () => this.emit({ maximized: !this.value.maximized });
  setPageVisible(visible: boolean) {
    if (visible !== this.value.pageVisible) this.emit({ pageVisible: visible });
  }
  setWidth = (width: number) => {
    if (!Number.isFinite(width) || Math.abs(width - this.value.width) < 0.1) return;
    this.emit({ width: Math.max(30, Math.min(70, width)) });
    this.persist();
  };
  removeChat(chatId: string) {
    this.memories.delete(chatId);
    if (this.value.active?.chatId === chatId)
      this.emit({ active: null, latest: null, hidden: false });
    if (this.value.latest?.chatId === chatId) this.emit({ latest: null });
    this.persist();
  }
}
