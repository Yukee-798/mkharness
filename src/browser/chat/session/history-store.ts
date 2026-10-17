import type { Message } from '@ag-ui/core';
import type { HistoryPage, HistoryWindow, HistoryAnnotations } from '../../../shared/conversation';
import { toMessages, aliasMessages } from '../../../shared/stream';
import type { Snapshot } from './snapshot';

/** One conversation's loaded projection. Native IDs, never text, determine identity. */
export class ConversationHistory {
  private current?: Snapshot;
  private annotations: HistoryAnnotations = {};
  private versions = new Map<string, number>();
  accept(window?: HistoryWindow) {
    if (!window) return this.annotations;
    for (const [id, value] of Object.entries(window.annotations))
      if (window.revision >= (this.versions.get(id) ?? -1)) {
        this.versions.set(id, window.revision);
        this.annotations[id] = value;
      }
    return { ...this.annotations };
  }
  adopt(next: Snapshot): Snapshot {
    let previous = this.current;
    if (previous && previous.conversationId !== next.conversationId) {
      this.annotations = {};
      this.versions.clear();
      this.current = undefined;
      previous = undefined;
    }
    const min = Number(next.entries[0]?.id ?? Infinity);
    const prefix = previous ? previous.entries.filter((entry) => Number(entry.id) < min) : [];
    const previousIds = new Set(previous?.entries.map((entry) => Number(entry.id)));
    const overlaps = next.entries.some((entry) => previousIds.has(Number(entry.id)));
    const entries = [...prefix, ...next.entries];
    this.current = {
      ...next,
      entries,
      toolProgress: { ...previous?.toolProgress, ...next.toolProgress },
      history: {
        ...next.history,
        ...(prefix.length && overlaps ? { olderCursor: previous?.history?.olderCursor } : {}),
        annotations: this.accept(next.history),
      },
    };
    return this.current;
  }
  prepend(page: HistoryPage, current: Snapshot): Snapshot {
    const entries = new Map(page.entries.map((entry) => [Number(entry.id), entry]));
    for (const entry of current.entries) entries.set(Number(entry.id), entry);
    this.current = {
      ...current,
      entries: [...entries.values()].sort((a, b) => Number(a.id) - Number(b.id)),
      toolProgress: { ...page.toolProgress, ...current.toolProgress },
      history: {
        ...page.history,
        upperEntryId: current.history.upperEntryId,
        revision: Math.max(current.history.revision, page.history.revision),
        annotations: this.accept(page.history),
      },
    };
    return this.current;
  }
  mergeMessages(incoming: Message[], aliases: Map<string, string>): Message[] {
    if (!this.current?.history) return incoming;
    const inverse = new Map([...aliases].map(([canonical, live]) => [live, canonical]));
    const entryId = (id: string) => Number((inverse.get(id) ?? id).split(':')[0]);
    const min = Math.min(...incoming.map((message) => entryId(message.id)).filter(Number.isFinite));
    const prefix = aliasMessages(toMessages(this.current.entries), aliases).filter(
      (message) => entryId(message.id) < min,
    );
    return [...prefix, ...incoming];
  }
}
