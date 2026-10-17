import { useEffect, useMemo, useRef } from 'react';
import { useMutation, useMutationState, useQueryClient } from '@tanstack/react-query';
import type { Json } from '../../../shared/json';
import type { CreateConversationRequest, RunCommand } from '../../../shared/contracts';
import { conversationRemote, type ConversationRemote } from './remote';
import { userKeys } from '../../queries';
import { createSubmitter } from './submission';

type Submission = {
  id: string;
  command: RunCommand;
  initial: boolean;
  creation?: CreateConversationRequest;
  // Acknowledged product identity only. Native submission state stays on the server.
  createdId?: string;
};
const belongsTo = (submission: Submission | undefined, id: string) =>
  !!submission &&
  (submission.createdId === id || (submission.id === id && (!!id || !submission.createdId)));

/** Creation and submission receipts share one mutation. Explicit retries retain both IDs;
 * navigation never cancels a request and restoring a view never submits work. */
export function useSubmission(
  userId: string,
  id: string,
  onCreated?: (id: string) => void,
  creation?: Record<string, Json>,
  remote: ConversationRemote = conversationRemote,
) {
  const creationRef = useRef(creation);
  creationRef.current = creation;
  const client = useQueryClient();
  const mutationKey = userKeys(userId).submissions;
  const attempts = useMutationState({
    filters: { mutationKey, exact: true },
    select: (mutation) => ({
      submission: mutation.state.variables as Submission | undefined,
      status: mutation.state.status,
      error: mutation.state.error,
    }),
  });
  const latest = attempts.findLast((attempt) => belongsTo(attempt.submission, id));
  const previous = useRef(latest);
  previous.current = latest;
  const createdId = useRef(id);
  const creationAttempt = useRef<CreateConversationRequest | undefined>(undefined);
  const mounted = useRef(true);
  const created = useRef(onCreated);
  created.current = onCreated;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const mutation = useMutation({
    mutationKey,
    retry: false,
    gcTime: Infinity,
    onMutate: (submission: Submission) => {
      for (const attempt of client.getMutationCache().findAll({ mutationKey, exact: true })) {
        const variables = attempt.state.variables as Submission | undefined;
        if (
          belongsTo(variables, submission.createdId ?? submission.id) &&
          attempt.state.status !== 'pending'
        )
          client.getMutationCache().remove(attempt);
      }
    },
    mutationFn: async (submission: Submission) => {
      let chatId = submission.createdId || submission.id;
      if (!chatId) {
        if (!submission.creation) throw new Error('Missing creation request');
        const result = await remote.create(submission.creation);
        if (!result || typeof result.id !== 'string' || !result.id)
          throw new Error('protocol_mismatch: Refresh to load the current chat protocol.');
        chatId = result.id;
        // Keep the create receipt with the pending mutation before navigating away.
        submission.createdId = chatId;
        createdId.current = chatId;
        if (mounted.current) created.current?.(chatId);
      }
      await remote.submit(chatId, submission.command);
      return { id: chatId };
    },
    onSuccess: (result, submission) => {
      if (!submission.initial) return;
      const queryKey = userKeys(userId).snapshot(result.id);
      void Promise.all([
        client
          .cancelQueries({ queryKey, exact: true })
          .then(() => client.invalidateQueries({ queryKey })),
        client.invalidateQueries({ queryKey: userKeys(userId).directory }),
      ]);
    },
  });
  const { mutateAsync } = mutation;
  const send = useMemo(
    () =>
      createSubmitter(
        async (command) => {
          const initial = !createdId.current;
          if (initial && !creationAttempt.current) {
            creationAttempt.current = previous.current?.submission?.creation ?? {
              requestId: crypto.randomUUID(),
              ...structuredClone(creationRef.current ?? {}),
            };
          }
          await mutateAsync({
            id: createdId.current,
            command,
            initial,
            ...(initial ? { creation: creationAttempt.current } : {}),
          });
        },
        () =>
          previous.current?.status === 'error'
            ? previous.current.submission?.command
            : previous.current?.status === 'success'
              ? null
              : undefined,
      ),
    [mutateAsync],
  );
  const retry = () => {
    const submission = previous.current?.submission;
    if (!submission || previous.current?.status !== 'error') return Promise.resolve();
    if (
      client.isMutating({
        mutationKey,
        exact: true,
        predicate: (mutation) => belongsTo(mutation.state.variables as Submission | undefined, id),
      })
    )
      return Promise.resolve();
    return mutateAsync(submission).then(() => {});
  };
  return { send, retry, latest };
}
