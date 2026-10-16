import { useEffect, useMemo, useRef } from 'react';
import { useMutation, useMutationState, useQueryClient } from '@tanstack/react-query';
import type { Json } from '../../../shared/json';
import type { RunCommand } from '../../../shared/contracts';
import { conversationRemote, type ConversationRemote } from './remote';
import { userKeys } from '../../queries';
import { createSubmitter } from './submission';

type Submission = { id: string; command: RunCommand; initial: boolean };

/** HTTP receipt state only. Pi remains the task/history authority; navigation
 * does not cancel a mutation or resubmit it. No persistence or automatic retry. */
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
  const latest = attempts.findLast((attempt) => attempt.submission?.id === id);
  const previous = useRef(latest);
  previous.current = latest;
  const mutation = useMutation({
    mutationKey,
    retry: false,
    gcTime: Infinity,
    onMutate: (submission) => {
      // Prune older settled receipts; in-flight HTTP requests must still settle.
      // A failed receipt must not lose its retry ID to a background GC timer.
      for (const attempt of client.getMutationCache().findAll({ mutationKey, exact: true })) {
        const variables = attempt.state.variables as Submission | undefined;
        if (variables?.id === submission.id && attempt.state.status !== 'pending')
          client.getMutationCache().remove(attempt);
      }
    },
    mutationFn: ({ id, command }: Submission) => remote.submit(id, command),
    onSuccess: (_, submission) => {
      if (!submission.initial) return;
      // These callbacks belong to the mutation, not the unmounted first composer.
      // Refetch even if the early snapshot was read before Pi accepted the input.
      const queryKey = userKeys(userId).snapshot(submission.id);
      void Promise.all([
        client
          .cancelQueries({ queryKey, exact: true })
          .then(() => client.invalidateQueries({ queryKey })),
        client.invalidateQueries({ queryKey: userKeys(userId).directory }),
      ]);
    },
  });
  const { mutateAsync } = mutation;
  const createdId = useRef(id);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const created = useRef(onCreated);
  created.current = onCreated;
  const send = useMemo(
    () =>
      createSubmitter(
        async (command) => {
          const initial = !createdId.current;
          if (initial) createdId.current = (await remote.create(creationRef.current)).id;
          const receipt = mutateAsync({ id: createdId.current, command, initial });
          if (initial && mounted.current) created.current?.(createdId.current);
          await receipt;
        },
        () =>
          previous.current?.status === 'error'
            ? previous.current.submission?.command
            : previous.current?.status === 'success'
              ? null
              : undefined,
      ),
    [mutateAsync, remote],
  );
  const retry = () => {
    const submission = previous.current?.submission;
    if (!submission || previous.current?.status !== 'error') return Promise.resolve();
    if (
      client.isMutating({
        mutationKey,
        exact: true,
        predicate: (mutation) => (mutation.state.variables as Submission | undefined)?.id === id,
      })
    )
      return Promise.resolve();
    return mutateAsync(submission).then(() => {});
  };
  return { send, retry, latest };
}
