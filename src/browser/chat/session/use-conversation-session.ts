import { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Json } from '../../../shared/json';
import type { RunCommand } from '../../../shared/contracts';
import { resolveModelSelection, type ModelSelection } from '../../../shared/model-selection';
import { ApiError } from '../../api';
import { modelSettingsOptions } from '../../queries';
import { useConversationObservation } from './use-observation';
import type { ComposerDraft, DraftSubmission } from '../../workbench/composer-drafts';
import { useSubmission } from './use-submission';
import { emptySnapshot } from './snapshot';
import { ConversationHistory } from './history-store';
import { conversationRemote, type ConversationRemote } from './remote';
import { useConversationRuntime } from './use-runtime';
import { lastEntryId, outgoingMessage, type OutgoingBaseline } from './outgoing';
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
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<Error>();
  const olderFlight = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => olderFlight.current?.abort(), [historyStore]);
  const settings = useQuery({ ...modelSettingsOptions(userId), enabled: !!userId });
  const {
    send,
    retry: retrySubmission,
    latest,
  } = useSubmission(userId, id, onCreated, creation, remote);
  const initialSubmission = latest?.submission?.initial ? latest : undefined;
  const [error, setError] = useState<Error>();
  const [sending, setSending] = useState(false);
  // A follow-up stays visible from submission until Pi commits it; see outgoingMessage.
  const [baseline, setBaseline] = useState<OutgoingBaseline>();
  const [acknowledging, setAcknowledging] = useState(false);
  const observation = useConversationObservation({
    id,
    userId,
    remote,
    historyStore,
    onDirectoryChange,
    onUnavailable,
    onError: setError,
  });
  const {
    snapshot,
    restoration,
    connection,
    prependVersion,
    actOnQueue,
    acknowledgeQueueEdit,
    prepend,
    refresh,
    connected,
    disconnected: reconnect,
  } = observation;
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
  // Query owns read errors; keep submission/action errors separate so a successful
  // refetch clears stale read failures without hiding an unconfirmed submission.
  const visibleError =
    error ?? (latest?.status === 'error' ? latest.error : undefined) ?? observation.error;
  const credentialRequired =
    visibleError instanceof ApiError && visibleError.code === 'credential_required';
  const submitInput = async (
    message: string,
    source?: RunCommand['source'],
    images?: RunCommand['images'],
    workspaceReferences?: RunCommand['workspaceReferences'],
    draftSubmission?: DraftSubmission,
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
    if (id) {
      setBaseline({
        lastEntry: lastEntryId(snapshot?.entries ?? []),
        idle: !!snapshot && !observation.hasPending,
      });
      setAcknowledging(true);
    }
    let receipt: Awaited<ReturnType<typeof send>>;
    try {
      receipt = await send(message, source, selected, images, workspaceReferences, draftSubmission);
    } catch (e) {
      setAcknowledging(false);
      if (e instanceof ApiError && e.code === 'credential_required')
        onSettings?.(selected?.provider);
      throw e;
    } finally {
      setSending(false);
    }
    if (!id) return;
    setError(undefined);
    try {
      await observation.accepted(receipt);
    } finally {
      setAcknowledging(false);
    }
  };
  const submit = (
    message: string,
    source?: RunCommand['source'],
    images?: RunCommand['images'],
    workspaceReferences?: RunCommand['workspaceReferences'],
  ) => submitInput(message, source, images, workspaceReferences);
  // The wrapper uses assistant-ui focus behavior; submission deliberately stays HTTP-only.
  // Calling runtime.send/abort here would replace the live subscription or cancel a durable task.
  const renderedSnapshot = snapshot ?? (!id || initialSubmission ? emptySnapshot : undefined);
  const outgoing = renderedSnapshot
    ? outgoingMessage(renderedSnapshot, latest, baseline, acknowledging)
    : undefined;
  const submitting = sending || latest?.status === 'pending';
  const composerReady = !!userId && (!id || !!renderedSnapshot);
  const hasPending = observation.hasPending;
  const isStopping = stopSending || !!snapshot?.stopping;
  const loadOlder = useCallback(async () => {
    const cursor = snapshot?.history?.olderCursor;
    const target = snapshot?.conversationId;
    if (!cursor || target === undefined || olderFlight.current) return;
    const controller = new AbortController();
    olderFlight.current = controller;
    setHistoryLoading(true);
    setHistoryError(undefined);
    try {
      const page = await remote.history(id, cursor, controller.signal, target);
      if (controller.signal.aborted) return;
      prepend(page, target);
    } catch (error) {
      if (!controller.signal.aborted) setHistoryError(error as Error);
    } finally {
      if (olderFlight.current === controller) olderFlight.current = undefined;
      if (!controller.signal.aborted) setHistoryLoading(false);
    }
  }, [id, snapshot?.history.olderCursor, snapshot?.conversationId, remote, prepend]);
  const retry = async () => {
    setError(undefined);
    try {
      setAcknowledging(true);
      const result = await retrySubmission();
      if (result && !initialSubmission) await observation.accepted(result.receipt);
    } catch (error) {
      setError(error as Error);
    } finally {
      setAcknowledging(false);
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
    outgoing,
    restoration,
    done: refresh,
    reconnect,
    connected,
    historyStore,
    prependVersion,
    remote,
    queue: observation.queue,
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
    submitDraft: (
      draft: ComposerDraft,
      images?: RunCommand['images'],
      imageIds?: ReadonlySet<string>,
    ) => {
      const attempt = draft.beginSubmission(imageIds);
      const input = attempt.input;
      return submitInput(input.text, input.source, images, input.workspaceReferences, attempt);
    },
    retrySubmission: retry,
    stop,
    actOnQueue,
    acknowledgeQueueEdit,
    loadOlder,
    selectModel: setSelection,
    reportError: setError,
    reconnect: () => {
      setError(undefined);
      observation.reconnect();
    },
  };
}
export type ConversationSession = ReturnType<typeof useConversationSession>;
