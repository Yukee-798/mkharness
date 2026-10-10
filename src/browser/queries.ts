import { focusManager, infiniteQueryOptions } from '@tanstack/react-query';
import { request } from './api';
export type Conversation = { id: string; title: string; updated_at: number };
export type Directory = { items: Conversation[]; next: string | null };
export const userKeys = (userId: string) => ({
  directory: ['user', userId, 'directory'] as const,
  snapshot: (id: string) => ['user', userId, 'chat', id, 'snapshot'] as const,
});
export const directoryOptions = (userId: string) =>
  infiniteQueryOptions({
    queryKey: userKeys(userId).directory,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      request<Directory>(
        '/conversations' + (pageParam ? '?cursor=' + encodeURIComponent(pageParam) : ''),
        { signal },
      ),
    getNextPageParam: (lastPage) => lastPage.next,
    retry: false,
  });

// Preserve directory synchronization when returning to the window as well as the tab.
if (typeof window !== 'undefined') {
  focusManager.setEventListener((onFocus) => {
    const visible = () => onFocus();
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('focus', visible);
      document.removeEventListener('visibilitychange', visible);
    };
  });
}
