export type Span = { startedAt: number; endedAt?: number };
export type TimingState = {
  tools: Record<string, Span>;
  replies: Record<string, Span & { runId: string }>;
};
export function formatDuration(ms: number) {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}
