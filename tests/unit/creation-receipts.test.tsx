// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSubmission } from '../../src/browser/chat/session/use-submission';
import { conversationRemote } from '../../src/browser/chat/session/remote';
import type { CreateConversationRequest, RunCommand } from '../../src/shared/contracts';

afterEach(cleanup);

it('retains the create ID and frozen selection after a lost receipt and composer remount', async () => {
  const client = new QueryClient();
  const requests: CreateConversationRequest[] = [];
  const submit = vi.fn(async () => {});
  const created = vi.fn();
  const remote = {
    ...conversationRemote,
    create: async (request: CreateConversationRequest) => {
      requests.push(structuredClone(request));
      if (requests.length === 1) throw new Error('create acknowledgement lost');
      return { id: 'chat' };
    },
    submit,
  };
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const first = renderHook(() => useSubmission('owner', '', created, { skillIds: [] }, remote), {
    wrapper,
  });
  await act(async () => {
    await expect(first.result.current.send('hello')).rejects.toThrow('acknowledgement lost');
  });
  await waitFor(() => expect(first.result.current.latest?.status).toBe('error'));
  first.unmount();
  const second = renderHook(
    () =>
      useSubmission(
        'owner',
        '',
        created,
        { skillIds: ['00000000-0000-4000-8000-000000000001'] },
        remote,
      ),
    { wrapper },
  );
  await act(async () => {
    await second.result.current.retry();
  });
  expect(requests).toHaveLength(2);
  expect(requests[0]!.requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[1]!.skillIds).toEqual([]);
  expect(submit).toHaveBeenCalledOnce();
  expect(submit).toHaveBeenCalledWith('chat', expect.objectContaining({ text: 'hello' }));
  expect(created).toHaveBeenCalledExactlyOnceWith('chat');
  second.unmount();
  client.clear();
});

it('retries a lost first submission after navigation without creating a second chat', async () => {
  const client = new QueryClient();
  const commands: RunCommand[] = [];
  const create = vi.fn(async () => ({ id: 'chat' }));
  const remote = {
    ...conversationRemote,
    create,
    submit: async (_id: string, command: RunCommand) => {
      commands.push(command);
      if (commands.length === 1) throw new Error('submission acknowledgement lost');
    },
  };
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const first = renderHook(() => useSubmission('owner', '', undefined, undefined, remote), {
    wrapper,
  });
  await act(async () => {
    await expect(first.result.current.send('hello')).rejects.toThrow('acknowledgement lost');
  });
  first.unmount();
  const second = renderHook(() => useSubmission('owner', 'chat', undefined, undefined, remote), {
    wrapper,
  });
  await waitFor(() => expect(second.result.current.latest?.status).toBe('error'));
  await act(async () => {
    await second.result.current.retry();
  });
  expect(create).toHaveBeenCalledOnce();
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual(commands[0]);
  second.unmount();
  client.clear();
});
