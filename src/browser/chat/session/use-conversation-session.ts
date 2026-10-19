import { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Json } from '../../../shared/json';
import type { RunCommand } from '../../../shared/contracts';
import type { QueueAction } from '../../../shared/queue';
import { resolveModelSelection, type ModelSelection } from '../../../shared/model-selection';
import { ApiError } from '../../api';
import { userKeys, modelSettingsOptions } from '../../queries';
import { useSubmission } from './use-submission';
import { emptySnapshot, type Snapshot } from './snapshot';
import { ConversationHistory } from './history-store';
import { conversationRemote, type ConversationRemote } from './remote';
import { useConversationRuntime } from './use-runtime';
export type ConversationSessionOptions = {
  id: string;
  userId: string;
  onDirectoryChange?: () => void;
  onUnavailable?: () => void;
  onCreated?: (id: string) => void;
  onSettings?: (provider?: string) => void;
  onModelProviderChange?: (provider: string | undefined) => void;
  creation?: Record<string, Json>;
  remote?: ConversationRemote;
};
export function useConversationSession({
  id,
  userId,
  onDirectoryChange,
  onUnavailable,
  onCreated,
  onSettings,
  onModelProviderChange,
  creation,
  remote = conversationRemote,
}: ConversationSessionOptions) {
  const historyStore = useMemo(() => new ConversationHistory(), []);
  const [prependVersion, setPrependVersion] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<Error>();
  const olderFlight = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => olderFlight.current?.abort(), [historyStore]);
  const unavailable = useRef(onUnavailable);
  unavailable.current = onUnavailable;
  const query = useQuery({
    queryKey: userKeys(userId).snapshot(id),
    queryFn: ({ signal }) => remote.snapshot(id, signal),
    retry: false,
    enabled: !!userId && !!id,
  });
  const settings = useQuery({ ...modelSettingsOptions(userId), enabled: !!userId });
  const {
    send,
    retry: retrySubmission,
    latest,
  } = useSubmission(userId, id, onCreated, creation, remote);
  const initialSubmission = latest?.submission?.initial ? latest : undefined;
  const [snapshot, setSnapshot] = useState<Snapshot>(),
    [revision, setRevision] = useState(0),
    [restoration, setRestoration] = useState(0),
    [error, setError] = useState<Error>(),
    [ackPending, setAckPending] = useState(false),
    [sending, setSending] = useState(false);
  const queueEpoch = useRef(0);
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
  const retries = useRef(0);
  const [selection, setSelection] = useState<ModelSelection>();
  const [stopSending, setStopSending] = useState(false);
  const catalog = settings.data?.modelCatalog ?? snapshot?.modelCatalog;
  const selected = catalog
    ? resolveModelSelection(
        catalog,
        selection ??
          (initialSubmission?.status !== 'success'
            ? initialSubmission?.submission?.command.config
            : undefined) ??
          snapshot?.selection,
      )
    : undefined;
  useEffect(() => {
    onModelProviderChange?.(selected?.provider);
  }, [selected?.provider, onModelProviderChange]);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [connection, setConnection] = useState<'reconnecting' | 'recovered'>();
  useEffect(() => () => clearTimeout(reconnectTimer.current), []);
  useEffect(() => {
    if (connection !== 'recovered') return;
    const timer = setTimeout(() => setConnection(undefined), 3000);
    return () => clearTimeout(timer);
  }, [connection]);
  const { refetch: refetchSnapshot } = query;
  const restoredRevision = useRef(0);
  const adoptedQuery = useRef<Snapshot | undefined>(undefined);
  useEffect(() => {
    // Idle chats must adopt fresh reads after focus or a cached revisit. Active observation and
    // explicit restoration own their history; background reads must not interrupt either one.
    if (
      restoredRevision.current !== revision ||
      !id ||
      !query.isSuccess ||
      !query.data ||
      snapshot?.pending.length ||
      adoptedQuery.current === query.data
    )
      return;
    adoptedQuery.current = query.data;
    setSnapshot(historyStore.adopt(currentTransfers(query.data)));
  }, [id, revision, query.data, query.isSuccess, snapshot, historyStore, currentTransfers]);
  useEffect(() => {
    if (!id || revision === 0) return;
    let active = true;
    const epoch = queueEpoch.current;
    void refetchSnapshot().then(({ data: s, isSuccess }) => {
      // A failed Query refetch retains cached data. Only a successful read may restore
      // history and attach; otherwise cached pending work can form a terminal SSE loop.
      if (!active || !isSuccess || !s) return;
      restoredRevision.current = revision;
      adoptedQuery.current = s;
      setSnapshot((current) =>
        historyStore.adopt(
          currentTransfers(
            epoch === queueEpoch.current ? s : { ...s, queue: current?.queue ?? s.queue },
          ),
        ),
      );
      setRestoration(revision);
      setAckPending(false);
      if (!s.pending.length)
        setConnection((previous) => (previous === 'reconnecting' ? 'recovered' : previous));
    });
    return () => {
      active = false;
    };
  }, [id, revision, refetchSnapshot, historyStore, currentTransfers]);
  useEffect(() => {
    const e = query.error;
    if (!e) return;
    setConnection(undefined);
    if (e instanceof ApiError && e.status === 404 && unavailable.current) unavailable.current();
  }, [query.error]);
  // Query owns read errors; keep submission/action errors separate so a successful
  // refetch clears stale read failures without hiding an unconfirmed submission.
  const visibleError =
    error ?? (latest?.status === 'error' ? latest.error : undefined) ?? query.error;
  const credentialRequired =
    visibleError instanceof ApiError && visibleError.code === 'credential_required';
  const submit = async (
    message: string,
    source?: RunCommand['source'],
    images?: RunCommand['images'],
    workspaceReferences?: RunCommand['workspaceReferences'],
  ) => {
    if (!userId) throw new ApiError(401, 'unauthorized', '请先登录');
    if (
      !id &&
      (!selected ||
        !settings.data ||
        settings.data.credentials.find((c) => c.provider === selected.provider)?.effectiveSource ===
          'none')
    ) {
      onSettings?.(selected?.provider);
      throw new ApiError(400, 'credential_required', '请先配置所选模型的 Base URL 与 API Key');
    }
    setSending(true);
    try {
      await send(message, source, selected, images, workspaceReferences);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'credential_required')
        onSettings?.(selected?.provider);
      throw e;
    } finally {
      setSending(false);
    }
    if (!id) return;
    onDirectoryChange?.();
    setAckPending(true);
    retries.current = 0;
    setError(undefined);
    if (!snapshot?.pending.length) setRevision((r) => r + 1);
    else {
      const epoch = queueEpoch.current;
      const { data, isSuccess } = await refetchSnapshot();
      if (isSuccess && data) {
        setSnapshot((s) =>
          s
            ? {
                ...s,
                pending: data.pending,
                queue: epoch === queueEpoch.current ? data.queue : s.queue,
                queueEdits: currentTransfers(data).queueEdits,
              }
            : currentTransfers(data),
        );
        setAckPending(false);
      }
    }
  };
  const refresh = () => {
    retries.current = 0;
    setRevision((r) => r + 1);
    onDirectoryChange?.();
  };
  const reconnect = (replacement = false) => {
    if (!replacement && retries.current >= 4) {
      setConnection(undefined);
      setError(new Error('连接已中断。重新连接后可以继续查看回复。'));
      return;
    }
    setConnection('reconnecting');
    const delay = replacement ? 0 : Math.min(500 * 2 ** retries.current++, 4000);
    clearTimeout(reconnectTimer.current);
    reconnectTimer.current = setTimeout(() => setRevision((r) => r + 1), delay);
  };
  const connected = () => {
    setConnection((previous) => (previous === 'reconnecting' ? 'recovered' : undefined));
  };
  useEffect(() => {
    if (!snapshot?.stopping) return;
    const timer = setTimeout(() => setRevision((r) => r + 1), 1000);
    return () => clearTimeout(timer);
  }, [snapshot]);
  // The wrapper uses assistant-ui focus behavior; submission deliberately stays HTTP-only.
  // Calling runtime.send/abort here would replace the live subscription or cancel a durable task.
  const renderedSnapshot = snapshot ?? (!id || initialSubmission ? emptySnapshot : undefined);
  const submitting = sending || latest?.status === 'pending';
  const composerReady = !!userId && (!id || !!renderedSnapshot);
  const hasPending = !!snapshot?.pending.length || ackPending;
  const isStopping = stopSending || !!snapshot?.stopping;
  const loadOlder = useCallback(async () => {
    const cursor = snapshot?.history?.olderCursor;
    if (!cursor || olderFlight.current) return;
    const controller = new AbortController();
    olderFlight.current = controller;
    setHistoryLoading(true);
    setHistoryError(undefined);
    try {
      const page = await remote.history(id, cursor, controller.signal, snapshot?.conversationId);
      if (controller.signal.aborted) return;
      setSnapshot((current) =>
        current?.conversationId === snapshot?.conversationId
          ? historyStore.prepend(page, current)
          : current,
      );
      setPrependVersion((value) => value + 1);
    } catch (error) {
      if (!controller.signal.aborted) setHistoryError(error as Error);
    } finally {
      if (olderFlight.current === controller) olderFlight.current = undefined;
      if (!controller.signal.aborted) setHistoryLoading(false);
    }
  }, [id, snapshot?.history.olderCursor, snapshot?.conversationId, remote, historyStore]);
  const actOnQueue = async (runId: string, action: QueueAction) => {
    const epoch = queueEpoch.current;
    try {
      const result = await remote.queue(id, runId, action, snapshot?.conversationId);
      if (epoch === queueEpoch.current)
        setSnapshot((current) => (current ? { ...current, queue: result.queue } : current));
      return result;
    } catch (error) {
      const { data, isSuccess } = await refetchSnapshot();
      if (isSuccess && data)
        setSnapshot((current) =>
          current
            ? {
                ...current,
                queue: epoch === queueEpoch.current ? data.queue : current.queue,
                queueEdits: currentTransfers(data).queueEdits,
              }
            : current,
        );
      throw error;
    }
  };
  const acknowledgeQueueEdit = async (runId: string) => {
    const target = snapshot?.conversationId;
    const result = await remote.acknowledgeQueueEdit(id, runId, target);
    if (target !== undefined) {
      acknowledgedEdits.current.add(`${target}:${runId}`);
      setSnapshot((current) =>
        current?.conversationId === target ? currentTransfers(current) : current,
      );
    }
    return result;
  };
  const retry = async () => {
    setError(undefined);
    try {
      await retrySubmission();
      if (!initialSubmission) refresh();
    } catch (error) {
      setError(error as Error);
    }
  };
  const stop = async () => {
    setStopSending(true);
    try {
      await remote.stop(id, snapshot?.conversationId);
      refresh();
    } catch (error) {
      setError(error as Error);
    } finally {
      setStopSending(false);
    }
  };
  const runtimeInfo = useConversationRuntime({
    id,
    userId,
    snapshot: renderedSnapshot ?? emptySnapshot,
    initialSubmission,
    restoration,
    done: refresh,
    reconnect,
    connected,
    historyStore,
    prependVersion,
    remote,
    queue: (value) => {
      queueEpoch.current++;
      setSnapshot((current) => (current ? { ...current, queue: value } : current));
    },
  });
  return {
    runtime: runtimeInfo.runtime,
    view: {
      id,
      userId,
      snapshot: renderedSnapshot,
      catalog,
      selected,
      initialSubmission,
      submitting,
      hasPending,
      isStopping,
      composerReady,
      connection,
      error: visibleError,
      credentialRequired,
      settingsPending: settings.isPending,
      submissionFailed: latest?.status === 'error',
      extensions: runtimeInfo.extensions,
      messageIds: runtimeInfo.messageIds,
      extensionState: runtimeInfo.extensionState,
      toolProgress: runtimeInfo.toolProgress,
      runtimeIssues: runtimeInfo.runtimeIssues,
      annotations: runtimeInfo.annotations,
      hasOlder: !!snapshot?.history?.olderCursor,
      historyLoading,
      historyError,
    },
    submit,
    retrySubmission: retry,
    stop,
    actOnQueue,
    acknowledgeQueueEdit,
    loadOlder,
    selectModel: setSelection,
    reportError: setError,
    reconnect: () => {
      retries.current = 0;
      setConnection('reconnecting');
      setError(undefined);
      setRevision((value) => value + 1);
    },
  };
}
export type ConversationSession = ReturnType<typeof useConversationSession>;
