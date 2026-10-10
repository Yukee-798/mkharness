import type { RawState } from '../shared/contracts';
import { jsonEqual } from '../shared/compute';
export type SaveStatus = 'saved' | 'saving' | 'unsaved' | 'error' | 'conflict';
export function createDraftSaver(
  save: (state: RawState, revision: number) => Promise<number>,
  initialRevision: number,
  report: (status: SaveStatus) => void,
  initialState: RawState = {},
) {
  let state: RawState = structuredClone(initialState),
    revision = initialRevision,
    version = 0,
    persisted = 0,
    inflight = false,
    disposed = false,
    blocked = false,
    conflict = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    clearTimeout(timer);
    if (!disposed && !blocked) timer = setTimeout(() => void flush(), 500);
  };
  const flush = async () => {
    if (disposed || blocked || inflight || version === persisted) return;
    const saving = version,
      snapshot = structuredClone(state);
    inflight = true;
    report('saving');
    try {
      revision = await save(snapshot, revision);
      persisted = saving;
      if (!disposed) report(version === persisted ? 'saved' : 'unsaved');
    } catch (error) {
      blocked = true;
      conflict = (error as { status?: number })?.status === 409;
      if (!disposed) report(conflict ? 'conflict' : 'error');
    } finally {
      inflight = false;
      if (!disposed && !blocked && version !== persisted) schedule();
    }
  };
  return {
    update: (next: RawState) => {
      if (jsonEqual(state, next)) return;
      state = structuredClone(next);
      version++;
      if (!blocked) report('unsaved');
      schedule();
    },
    retry: () => {
      if (disposed || conflict) return;
      blocked = false;
      schedule();
    },
    current: () => structuredClone(state),
    dirty: () => version !== persisted || inflight,
    dispose: () => {
      disposed = true;
      clearTimeout(timer);
    },
  };
}
export type PanelDraft = {
  saver: ReturnType<typeof createDraftSaver>;
  status: SaveStatus;
  subscribe: (listener: (status: SaveStatus) => void) => () => void;
};
// UI memory lives above chat/runtime replacement. Pi tools remain the only source
// for the immutable UI/program; this cache owns raw edits and their pending save.
export function createPanelDrafts() {
  const drafts = new Map<string, PanelDraft>();
  return {
    open(
      key: string,
      state: RawState,
      revision: number,
      save: (state: RawState, revision: number) => Promise<number>,
    ) {
      const previous = drafts.get(key);
      if (previous?.saver.dirty()) return previous;
      previous?.saver.dispose();
      const listeners = new Set<(status: SaveStatus) => void>();
      const draft: PanelDraft = {
        status: 'saved',
        saver: createDraftSaver(
          save,
          revision,
          (status) => {
            draft.status = status;
            for (const listener of listeners) listener(status);
          },
          state,
        ),
        subscribe: (listener) => {
          listeners.add(listener);
          listener(draft.status);
          return () => {
            listeners.delete(listener);
          };
        },
      };
      drafts.set(key, draft);
      return draft;
    },
    removeConversation(id: string) {
      for (const [key, draft] of drafts) {
        if (key.startsWith(id + '/')) {
          draft.saver.dispose();
          drafts.delete(key);
        }
      }
    },
    dispose() {
      for (const draft of drafts.values()) draft.saver.dispose();
      drafts.clear();
    },
  };
}
