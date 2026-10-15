import { request } from '../../browser/api';
import type { SkillView } from '../../shared/skills';

export const skillQueryKey = (userId: string) => ['user', userId, 'skills'];
export const skillQuery = (userId: string) => ({
  queryKey: skillQueryKey(userId),
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    request<{ skills: SkillView[] }>('/skills', { signal }),
  retry: false as const,
});
