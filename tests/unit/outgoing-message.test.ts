import { describe, expect, it } from 'vitest';
import type { EntryRecord } from '@earendil-works/pi-durable';
import type { Message } from '@ag-ui/core';
import type { RunCommand } from '../../src/shared/contracts';
import { emptySnapshot, type Snapshot } from '../../src/browser/chat/session/snapshot';
import {
  lastEntryId,
  outgoingMessage,
  type OutgoingAttempt,
} from '../../src/browser/chat/session/outgoing';
import { mergeObserved } from '../../src/browser/chat/session/transport';

const command = (runId: string) => ({ runId, text: 'hello' }) as RunCommand;
const entry = (id: number, role: 'user' | 'assistant') =>
  ({ id: String(id), model: [{ role, content: [] }] }) as unknown as EntryRecord;
const snapshot = (entries: EntryRecord[], pending: string[] = []): Snapshot => ({
  ...emptySnapshot,
  conversationId: 1,
  entries,
  pending: pending.map((operationId) => ({ operationId, status: 'running' as const })),
});
const attempt = (
  runId: string,
  status: OutgoingAttempt['status'],
  initial = false,
): OutgoingAttempt => ({ submission: { command: command(runId), initial }, status });

describe('outgoingMessage', () => {
  const history = [entry(1, 'user'), entry(2, 'assistant')];
  const idle = { lastEntry: lastEntryId(history), idle: true };

  it('shows the first message of a new chat until Pi exposes a user entry or accepted work', () => {
    expect(outgoingMessage(snapshot([]), attempt('a', 'pending', true), undefined, false)?.runId).toBe('a');
    expect(outgoingMessage(snapshot([], ['a']), attempt('a', 'success', true), undefined, false)).toBeUndefined();
    expect(outgoingMessage(snapshot([entry(1, 'user')]), attempt('a', 'success', true), undefined, false)).toBeUndefined();
  });

  it('shows a follow-up from an idle chat while its request is in flight', () => {
    expect(outgoingMessage(snapshot(history), attempt('b', 'pending'), idle, true)?.runId).toBe('b');
  });

  it('keeps an admitted follow-up until Pi commits a user entry past the baseline', () => {
    const admitted = snapshot(history, ['b']);
    expect(outgoingMessage(admitted, attempt('b', 'success'), idle, false)?.runId).toBe('b');
    // An assistant entry is not the follow-up's user entry.
    const answering = snapshot([...history, entry(3, 'assistant')], ['b']);
    expect(outgoingMessage(answering, attempt('b', 'success'), idle, false)?.runId).toBe('b');
    const placed = snapshot([...history, entry(3, 'user')], ['b']);
    expect(outgoingMessage(placed, attempt('b', 'success'), idle, false)).toBeUndefined();
  });

  it('keeps an acknowledged follow-up until its acknowledgement settles', () => {
    expect(outgoingMessage(snapshot(history), attempt('b', 'success'), idle, true)?.runId).toBe('b');
    // Settled and no longer listed: the admission was withdrawn or failed.
    expect(outgoingMessage(snapshot(history), attempt('b', 'success'), idle, false)).toBeUndefined();
  });

  it('never shows a queued input or a failed submission', () => {
    const busy = { lastEntry: 2, idle: false };
    expect(outgoingMessage(snapshot(history, ['a']), attempt('b', 'pending'), busy, true)).toBeUndefined();
    expect(outgoingMessage(snapshot(history), attempt('b', 'error'), idle, false)).toBeUndefined();
    expect(outgoingMessage(snapshot(history), attempt('b', 'pending'), undefined, true)).toBeUndefined();
  });
});

describe('mergeObserved', () => {
  const message = (id: string) => ({ id, role: 'user', content: id }) as Message;

  it('keeps the observed prefix and replaces messages from the frame’s first entry onward', () => {
    const observed = [message('1'), message('2'), message('3:0'), message('3:1')];
    expect(mergeObserved(observed, [message('3:0'), message('4')]).map((m) => m.id)).toEqual([
      '1',
      '2',
      '3:0',
      '4',
    ]);
  });

  it('accepts a full window as the first frame', () => {
    expect(mergeObserved([], [message('1'), message('2')]).map((m) => m.id)).toEqual(['1', '2']);
  });
});
