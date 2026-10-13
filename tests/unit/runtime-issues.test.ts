import { expect, it } from 'vitest';
import { compactionIssues } from '../../src/shared/runtime-issues';

it('projects native compaction failure identity without publishing its error', () => {
  const failure = {
    taskId: 7,
    reason: 'threshold',
    error: 'provider credential or deployment data',
  };
  expect(compactionIssues(failure)).toEqual([{ taskId: 7, code: 'compaction_failed' }]);
  expect(compactionIssues()).toEqual([]);
});
