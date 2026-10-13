/** Public status only: native errors may contain provider or deployment details. */
export type RuntimeIssue = {
  taskId: number;
  code: 'task_definition_unavailable' | 'compaction_failed';
};

export function compactionIssues(failure?: { taskId: number }): RuntimeIssue[] {
  return failure ? [{ taskId: Number(failure.taskId), code: 'compaction_failed' }] : [];
}
