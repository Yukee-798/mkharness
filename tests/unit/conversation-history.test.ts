import { it, expect } from 'vitest';
import { ConversationHistory } from '../../src/browser/chat/session/history-store';
import type { Snapshot } from '../../src/browser/chat/session/snapshot';
const entry = (id: number) =>
  ({ id, model: [{ role: 'user', content: 'message ' + id, timestamp: id }] }) as any;
const snapshot = (ids: number[], revision = 1): Snapshot => ({
  entries: ids.map(entry),
  pending: [],
  stopping: false,
  history: { upperEntryId: Math.max(...ids), revision, olderCursor: 'older', annotations: {} },
});

it('keeps a fresh cursor when the newest window no longer overlaps loaded history', () => {
  const history = new ConversationHistory();
  const old = snapshot([1, 2]);
  delete old.history!.olderCursor;
  history.adopt(old);
  const next = snapshot([500, 501], 2);
  next.history!.olderCursor = 'read-gap';
  const adopted = history.adopt(next);
  expect(adopted.entries.map((entry) => entry.id)).toEqual([1, 2, 500, 501]);
  expect(adopted.history!.olderCursor).toBe('read-gap');
});
it('retains loaded history across new window snapshots and ignores older annotations', () => {
  const history = new ConversationHistory();
  const first = history.adopt(snapshot([100, 101]));
  const older = history.prepend(
    {
      entries: [entry(98), entry(99)],
      history: {
        upperEntryId: 101,
        revision: 1,
        annotations: { '100': { reply: { value: 'old' } } },
      },
    },
    first,
  );
  expect(older.entries.map((e) => e.id)).toEqual([98, 99, 100, 101]);
  history.accept({
    upperEntryId: 102,
    revision: 3,
    annotations: { '100': { reply: { value: 'new' } } },
  });
  const refreshed = history.adopt(snapshot([101, 102], 2));
  expect(refreshed.entries.map((e) => e.id)).toEqual([98, 99, 100, 101, 102]);
  expect(refreshed.history!.annotations['100']).toEqual({ reply: { value: 'new' } });
  const merged = history.mergeMessages(
    [
      { id: '101', role: 'user', content: 'message 101' },
      { id: '102', role: 'user', content: 'message 102' },
    ],
    new Map(),
  );
  expect(merged.map((message) => message.id)).toEqual(['98', '99', '100', '101', '102']);
});
