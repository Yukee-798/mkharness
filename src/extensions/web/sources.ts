import type { ProjectionContext } from '../../server/contributions';
import { safeHref } from '../../shared/source-url';

export type WebSource = { url: string; title: string; snippet?: string };
export type SourcesState = { replies: Record<string, WebSource[]> };

/** Read-only public projection of successful tool results, scoped to each Pi reply. */
export function projectSources({ entries, submissions }: ProjectionContext): SourcesState {
  const history = [...entries].sort((a, b) => Number(a.id) - Number(b.id));
  const indices = new Map(history.map((entry, index) => [Number(entry.id), index]));
  const replies: SourcesState['replies'] = {};
  for (const submission of submissions) {
    if (submission.type !== 'input' || submission.status !== 'done') continue;
    const start = indices.get(Number(submission.entry));
    const end = indices.get(Number(submission.answer));
    if (start === undefined || end === undefined || end <= start) continue;
    const sources = new Map<string, WebSource>();
    for (const entry of history.slice(start + 1, end + 1)) {
      for (const message of entry.model ?? []) {
        if (
          message.role !== 'toolResult' ||
          message.isError ||
          !['read_web', 'search_web'].includes(message.toolName)
        )
          continue;
        try {
          const result = JSON.parse(
            message.content
              .filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join(''),
          );
          const candidates = message.toolName === 'search_web' ? result.results : [result];
          if (!Array.isArray(candidates)) continue;
          for (const candidate of candidates) {
            const url = safeHref(candidate?.url);
            if (!url || sources.has(url) || sources.size >= 20) continue;
            const title =
              typeof candidate.title === 'string' && candidate.title.trim()
                ? candidate.title.trim().slice(0, 300)
                : new URL(url).hostname;
            const text = candidate.content ?? candidate.text;
            sources.set(url, {
              url,
              title,
              ...(typeof text === 'string' ? { snippet: text.trim().slice(0, 280) } : {}),
            });
          }
        } catch {
          // A malformed result is still visible in tool history, never invented as a source.
        }
      }
    }
    if (sources.size) replies[String(submission.answer)] = [...sources.values()];
  }
  return { replies };
}
