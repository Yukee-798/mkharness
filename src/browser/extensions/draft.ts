import type { RawState } from '../../shared/contracts';
import { jsonEqual } from '../../shared/json';
export type SaveStatus = 'saved' | 'saving' | 'unsaved' | 'error' | 'conflict';
export function createDraftSaver(
  save: (state: RawState, revision: number) => Promise<number>,
  initialRevision: number,
  report: (status: SaveStatus) => void,
  initialState: RawState = {},
  read?: () => Promise<{ state: RawState; revision: number }>,
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
  let uncertain:
    { state: RawState; revision: number; version: number; conflict: boolean } | undefined;
  const reconcile = async () => {
    if (!read || !uncertain) return;
    const attempt = uncertain;
    const remote = await read();
    if (disposed) return;
    if (!Number.isSafeInteger(remote.revision) || remote.revision < attempt.revision)
      throw new Error('Invalid resource revision');
    if (remote.revision > attempt.revision && jsonEqual(remote.state, attempt.state)) {
      revision = remote.revision;
      persisted = attempt.version;
      uncertain = undefined;
      return;
    }
    if (remote.revision !== attempt.revision || attempt.conflict) throw { status: 409 };
    // The server is still at our last acknowledged version. A manual retry is safe.
    uncertain = undefined;
  };
  const schedule = () => {
    clearTimeout(timer);
    if (!disposed && !blocked) timer = setTimeout(() => void flush(), 500);
  };
  const flush = async () => {
    if (disposed || blocked || inflight || version === persisted) return;
    inflight = true;
    report('saving');
    try {
      // Keep the original uncertain attempt across offline reads and newer edits.
      if (uncertain) await reconcile();
      if (disposed) return;
      if (version !== persisted) {
        const attempt = { state: structuredClone(state), revision, version, conflict: false };
        try {
          revision = await save(attempt.state, attempt.revision);
          persisted = attempt.version;
        } catch (error) {
          if (read) {
            uncertain = { ...attempt, conflict: (error as { status?: number })?.status === 409 };
            await reconcile();
            if (!uncertain && persisted === attempt.version) {
              if (!disposed) report(version === persisted ? 'saved' : 'unsaved');
              return;
            }
          }
          throw error;
        }
      }
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
export type ResourceDraft = {
  saver: ReturnType<typeof createDraftSaver>;
  status: SaveStatus;
  subscribe: (listener: (status: SaveStatus) => void) => () => void;
};
// UI memory lives above chat/runtime replacement. Pi tools remain the only source
// for the immutable UI/program; this cache owns raw edits and their pending save.
export function createResourceDrafts() {
  const drafts = new Map<string, ResourceDraft>();
  return {
    open(
      scope: readonly [userId: string, conversationId: string, extensionId: string, ref: string],
      state: RawState,
      revision: number,
      save: (state: RawState, revision: number) => Promise<number>,
      read?: () => Promise<{ state: RawState; revision: number }>,
    ) {
      const key = JSON.stringify(scope);
      const previous = drafts.get(key);
      if (previous?.saver.dirty()) return previous;
      previous?.saver.dispose();
      const listeners = new Set<(status: SaveStatus) => void>();
      const draft: ResourceDraft = {
        status: 'saved',
        saver: createDraftSaver(
          save,
          revision,
          (status) => {
            draft.status = status;
            for (const listener of listeners) listener(status);
          },
          state,
          read,
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
    removeConversation(id: string, userId?: string) {
      for (const [key, draft] of drafts) {
        const scope = JSON.parse(key) as string[];
        if (scope[1] === id && (userId === undefined || scope[0] === userId)) {
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
