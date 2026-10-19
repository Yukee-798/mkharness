import { useCallback } from 'react';
import { useMutation, useMutationState, useQueryClient } from '@tanstack/react-query';
import { ApiError, request } from '../api';
import { workspaceError } from './error';
import type { WorkspaceCommand, WorkspaceReceipt } from '../../shared/workspace';

type Attempt = { scenarioId: string; command: WorkspaceCommand };

/** Receipts survive navigation, but are only visible/retriable in their original instance. */
export function useWorkspaceCommands(userId: string, scenarioId?: string) {
  const client = useQueryClient();
  const mutationKey = ['user', userId, 'workspace-command', scenarioId];
  const attempts = useMutationState({
    filters: { mutationKey, exact: true },
    select: (mutation) => ({
      attempt: mutation.state.variables as Attempt | undefined,
      status: mutation.state.status,
      error: mutation.state.error,
    }),
  });
  const latest = attempts.at(-1);
  const mutation = useMutation({
    mutationKey,
    retry: false,
    gcTime: Infinity,
    onMutate: () => {
      for (const old of client.getMutationCache().findAll({ mutationKey, exact: true }))
        if (old.state.status !== 'pending') client.getMutationCache().remove(old);
    },
    mutationFn: async ({ scenarioId: origin, command }: Attempt) => {
      try {
        return await request<WorkspaceReceipt>(
          `/scenarios/${encodeURIComponent(origin)}/workspace/execute`,
          { method: 'POST', body: JSON.stringify(command) },
        );
      } finally {
        await client.invalidateQueries({ queryKey: ['user', userId, 'workspace', origin] });
      }
    },
  });
  const { mutateAsync } = mutation;
  const executeCommand = useCallback(
    (command: WorkspaceCommand) => {
      if (!scenarioId) return Promise.reject(new Error('工作区尚未就绪，请稍后重试'));
      return mutateAsync({ scenarioId, command: structuredClone(command) });
    },
    [scenarioId, mutateAsync],
  );
  const error = latest?.status === 'error' ? latest.error : undefined;
  const retryable = error && (!(error instanceof ApiError) || error.status >= 500);
  return {
    executeCommand,
    busy: attempts.some((attempt) => attempt.status === 'pending'),
    error: error ? workspaceError(error) : undefined,
    retry: retryable && latest?.attempt ? () => mutateAsync(latest.attempt!) : undefined,
    clearError: () => {
      for (const old of client.getMutationCache().findAll({ mutationKey, exact: true }))
        if (
          old.state.status === 'error' &&
          old.state.error instanceof ApiError &&
          old.state.error.status < 500
        )
          client.getMutationCache().remove(old);
    },
  };
}
