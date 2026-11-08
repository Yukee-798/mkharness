import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { HistoryPage, SubmissionObservation } from '../../../shared/conversation';
import { ApiError } from '../../api';
import { userKeys } from '../../queries';
import type { QueueAction, QueuedInput } from '../../../shared/queue';
import type { ConversationHistory } from './history-store';
import type { ConversationRemote } from './remote';
import type { Snapshot } from './snapshot';

/** Owns observation ordering. A receipt or explicit restoration invalidates older reads;
 * only successful reads from the current generation may replace the native projection. */
export function useConversationObservation({
  id,
  userId,
  remote,
  historyStore,
  onDirectoryChange,
  onUnavailable,
  onError,
}: {
  id: string;
  userId: string;
  remote: ConversationRemote;
  historyStore: ConversationHistory;
  onDirectoryChange?: () => void;
  onUnavailable?: () => void;
  onError: (error: Error) => void;
}) {
  const acknowledgedEdits = useRef(new Set<string>());
  const currentTransfers = useCallback(
    (value: Snapshot): Snapshot => ({
      ...value,
      queueEdits: value.queueEdits.filter(
        (edit) => !acknowledgedEdits.current.has(`${value.conversationId}:${edit.runId}`),
      ),
    }),
    [],
  );
  const [prependVersion, setPrependVersion] = useState(0);
  const [snapshot, renderSnapshot] = useState<Snapshot>();
  const current = useRef<Snapshot | undefined>(undefined);
  const update = useCallback((change: (value: Snapshot | undefined) => Snapshot | undefined) => {
    current.current = change(current.current);
    renderSnapshot(current.current);
  }, []);
  const generation = useRef(0);
  const reads = useRef(new WeakMap<Snapshot, number>());
  const adopted = useRef<Snapshot | undefined>(undefined);
  const [revision, setRevision] = useState(0);
  const restoredRevision = useRef(0);
  const [restoration, setRestoration] = useState(0);
  const [ackPending, setAckPending] = useState(false);
  const queueEpoch = useRef(0);
  const callbacks = useRef({ onDirectoryChange, onUnavailable, onError });
  callbacks.current = { onDirectoryChange, onUnavailable, onError };
  const query = useQuery({
    queryKey: userKeys(userId).snapshot(id),
    queryFn: async ({ signal }) => {
      const epoch = generation.current;
      const value = await remote.snapshot(id, signal);
      reads.current.set(value, epoch);
      return value;
    },
    // Preserve read identity even when its JSON equals an older cached snapshot.
    structuralSharing: false,
    retry: false,
    enabled: !!userId && !!id,
  });
  const { refetch } = query;
  const retries = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [connection, setConnection] = useState<'reconnecting' | 'recovered'>();
  useEffect(() => () => clearTimeout(reconnectTimer.current), []);
  useEffect(() => {
    if (connection !== 'recovered') return;
    const timer = setTimeout(() => setConnection(undefined), 3000);
    return () => clearTimeout(timer);
  }, [connection]);
  useEffect(() => {
    const value = query.data;
    if (
      !id ||
      !query.isSuccess ||
      !value ||
      restoredRevision.current !== revision ||
      current.current?.pending.length ||
      adopted.current === value ||
      (reads.current.get(value) ?? 0) !== generation.current
    )
      return;
    adopted.current = value;
    update(() => historyStore.adopt(currentTransfers(value)));
  }, [id, query.data, query.isSuccess, revision, snapshot, historyStore, currentTransfers, update]);
  useEffect(() => {
    if (!id || revision === 0) return;
    let active = true;
    const epoch = generation.current;
    const queueVersion = queueEpoch.current;
    void refetch().then(({ data, isSuccess }) => {
      // Cached data retained by a failed refetch never authorizes restoration.
      if (
        !active ||
        !isSuccess ||
        !data ||
        epoch !== generation.current ||
        reads.current.get(data) !== epoch
      )
        return;
      restoredRevision.current = revision;
      adopted.current = data;
      update((value) =>
        historyStore.adopt(
          currentTransfers(
            queueVersion === queueEpoch.current
              ? data
              : { ...data, queue: value?.queue ?? data.queue },
          ),
        ),
      );
      setRestoration(revision);
      setAckPending(false);
      if (!data.pending.length)
        setConnection((previous) => (previous === 'reconnecting' ? 'recovered' : previous));
    });
    return () => {
      active = false;
    };
  }, [id, revision, refetch, historyStore, currentTransfers, update]);
  useEffect(() => {
    if (!query.error) return;
    setConnection(undefined);
    if (query.error instanceof ApiError && query.error.status === 404)
      callbacks.current.onUnavailable?.();
  }, [query.error]);
  const restore = () => {
    generation.current++;
    setRevision((value) => value + 1);
  };
  const refresh = () => {
    retries.current = 0;
    restore();
    callbacks.current.onDirectoryChange?.();
  };
  useEffect(() => {
    if (!snapshot?.stopping) return;
    const timer = setTimeout(() => {
      generation.current++;
      setRevision((value) => value + 1);
    }, 1000);
    return () => clearTimeout(timer);
  }, [snapshot]);
  const accepted = async (observation: SubmissionObservation | void) => {
    const epoch = ++generation.current;
    retries.current = 0;
    callbacks.current.onDirectoryChange?.();
    const value = current.current;
    if (
      value &&
      !value.pending.length &&
      !value.stopping &&
      observation?.pending.length &&
      observation.conversationId === value.conversationId
    ) {
      // The existing event stream restores its canonical prefix; no extra snapshot GET.
      update(() => ({ ...value, pending: observation.pending }));
      setAckPending(false);
      return;
    }
    setAckPending(true);
    if (!value?.pending.length) {
      setRevision((value) => value + 1);
      return;
    }
    const queueVersion = queueEpoch.current;
    const { data, isSuccess } = await refetch();
    if (!isSuccess || !data || generation.current !== epoch || reads.current.get(data) !== epoch)
      return;
    update((value) =>
      value
        ? {
            ...value,
            pending: data.pending,
            queue: queueVersion === queueEpoch.current ? data.queue : value.queue,
            queueEdits: currentTransfers(data).queueEdits,
          }
        : currentTransfers(data),
    );
    setAckPending(false);
  };
  const prepend = useCallback(
    (page: HistoryPage, target: number) => {
      if (current.current?.conversationId !== target) return;
      update((value) => (value ? historyStore.prepend(page, value) : value));
      setPrependVersion((value) => value + 1);
    },
    [historyStore, update],
  );
  const actOnQueue = async (runId: string, action: QueueAction) => {
    const epoch = queueEpoch.current;
    try {
      const result = await remote.queue(id, runId, action, current.current?.conversationId);
      if (epoch === queueEpoch.current)
        update((value) => (value ? { ...value, queue: result.queue } : value));
      return result;
    } catch (error) {
      const { data, isSuccess } = await refetch();
      if (isSuccess && data)
        update((value) =>
          value
            ? {
                ...value,
                queue: epoch === queueEpoch.current ? data.queue : value.queue,
                queueEdits: currentTransfers(data).queueEdits,
              }
            : currentTransfers(data),
        );
      throw error;
    }
  };
  const acknowledgeQueueEdit = async (runId: string) => {
    const target = current.current?.conversationId;
    const result = await remote.acknowledgeQueueEdit(id, runId, target);
    if (target !== undefined) {
      acknowledgedEdits.current.add(`${target}:${runId}`);
      update((value) => (value?.conversationId === target ? currentTransfers(value) : value));
    }
    return result;
  };
  return {
    snapshot,
    restoration,
    connection,
    error: query.error,
    hasPending: !!snapshot?.pending.length || ackPending,
    prependVersion,
    prepend,
    queue: (value: QueuedInput[]) => {
      queueEpoch.current++;
      update((current) => (current ? { ...current, queue: value } : current));
    },
    actOnQueue,
    acknowledgeQueueEdit,
    accepted,
    refresh,
    connected: () => setConnection((value) => (value === 'reconnecting' ? 'recovered' : undefined)),
    disconnected: (replacement = false) => {
      if (!replacement && retries.current >= 4) {
        setConnection(undefined);
        callbacks.current.onError(new Error('连接已中断。重新连接后可以继续查看回复。'));
        return;
      }
      setConnection('reconnecting');
      const delay = replacement ? 0 : Math.min(500 * 2 ** retries.current++, 4000);
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = setTimeout(restore, delay);
    },
    reconnect: () => {
      retries.current = 0;
      setConnection('reconnecting');
      restore();
    },
  };
}
