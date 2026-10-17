import { expect, it, vi } from 'vitest';
import {
  Harness,
  MemoryStorage,
  createRegistry,
  defineTool,
  UserEntry,
  AssistantEntry,
  ToolResultEntry,
  type Conversation,
  type EntryId,
  type EntryRecord,
} from '@earendil-works/pi-durable';
import { ConversationReadModel } from '../../src/server/chat/read-model';
import { readSuccessfulTool } from '../../src/server/chat/history';
import type { ConversationFactsIndex } from '../../src/server/chat/facts-index';
import { decodeSnapshot, decodeHistoryPage } from '../../src/shared/conversation';
import { BG } from '../../src/server/chat/context';
import { fixtureModels, usage } from '../fixture-model';
import { nativeSkills } from '../../src/server/skills/native';
import { Type } from '@earendil-works/pi-ai';

const selection = { provider: 'fixture', modelId: 'fixture', thinkingLevel: 'off' as const };
function reader(pi: Harness, conversation: Conversation, chatId = 'chat') {
  const facts = vi.fn(async (_target: unknown, entries: readonly EntryRecord[]) => ({
    entries,
    tasks: [],
    submissions: [],
  }));
  const source = {
    chatId,
    target: conversation.id,
    pi: async () => pi,
    pending: async () => [],
    queuedInputs: async () => [],
    queueEdits: async () => [],
    stopping: () => false,
    contributions: async () => [],
    configuration: async () => ({
      selection,
      modelCatalog: { models: [], defaultSelection: selection },
    }),
    index: {
      revision: async () => 1,
      lowerBound: async (_owner: unknown, lower: number) => lower,
      facts,
    } as unknown as ConversationFactsIndex,
  };
  return { model: new ConversationReadModel(source), facts };
}

it('reads bounded inherited fork pages, pins the older-page boundary and rejects cross-target cursors', async () => {
  const store = new MemoryStorage();
  const pi = await Harness.open(store, { models: fixtureModels(), registry: createRegistry() }, BG);
  try {
    const root = await pi.root(BG),
      ids: EntryId[] = [];
    await root.commit(async (tx) => {
      for (let index = 0; index < 250; index++)
        ids.push(
          (
            await tx.appendEntry(UserEntry, root.id, {
              model: [{ role: 'user', content: String(index), timestamp: index }],
            })
          ).id,
        );
    }, BG);
    const branch = await root.fork(ids[150]!, { ownership: { kind: 'ownerless' } }, BG);
    await branch.commit(async (tx) => {
      for (let index = 0; index < 20; index++)
        await tx.appendEntry(UserEntry, branch.id, {
          model: [{ role: 'user', content: 'branch ' + index, timestamp: index }],
        });
    }, BG);
    const { model, facts } = reader(pi, branch);
    const scans = vi.spyOn(store, 'scanEntries');
    const writes = vi.spyOn(store, 'commit');
    const snapshot = decodeSnapshot(JSON.parse(await model.snapshot()));
    expect(snapshot.conversationId).toBe(Number(branch.id));
    expect(snapshot.entries).toHaveLength(100);
    expect(
      snapshot.entries.every(
        (entry) => entry.conversationId === branch.id || Number(entry.id) <= Number(ids[150]),
      ),
    ).toBe(true);
    expect(scans.mock.calls.length).toBeLessThanOrEqual(3);
    expect(scans.mock.calls.every(([, limit]) => limit <= 100)).toBe(true);
    expect(writes).not.toHaveBeenCalled();
    writes.mockRestore();
    const cursor = snapshot.history.olderCursor!;
    await branch.commit(async (tx) => {
      await tx.appendEntry(UserEntry, branch.id, {
        model: [{ role: 'user', content: 'new while paging', timestamp: 0 }],
      });
    }, BG);
    const older = decodeHistoryPage(await model.readHistory(cursor));
    expect(older.entries).toHaveLength(71);
    expect(older.history.upperEntryId).toBe(snapshot.history.upperEntryId);
    expect(older.entries.every((entry) => Number(entry.id) < Number(snapshot.entries[0]!.id))).toBe(
      true,
    );
    expect(facts.mock.calls.every(([, entries]) => entries.length <= 100)).toBe(true);
    await expect(reader(pi, root).model.readHistory(cursor)).rejects.toThrow('invalid_cursor');
    await expect(reader(pi, branch, 'other-chat').model.readHistory(cursor)).rejects.toThrow(
      'invalid_cursor',
    );
    scans.mockRestore();
  } finally {
    await pi.close(BG);
  }
});

it('rejects obsolete or malformed transport envelopes instead of downgrading the read protocol', () => {
  const current = {
    conversationId: 1,
    entries: [],
    pending: [],
    stopping: false,
    queue: [],
    queueEdits: [],
    history: { upperEntryId: 0, revision: 0, annotations: {} },
  };
  expect(decodeSnapshot(current)).toEqual(current);
  for (const invalid of [
    { ...current, history: undefined },
    { ...current, queue: undefined },
    { ...current, queueEdits: undefined },
    { ...current, queueEdits: [{ runId: 'draft', expiresAt: 0 }] },
    { ...current, queueEdits: [{ runId: 'draft', expiresAt: 1, draft: 'private' }] },
    {
      ...current,
      queueEdits: Array.from({ length: 33 }, (_, n) => ({ runId: String(n), expiresAt: 1 })),
    },
    {
      ...current,
      queueEdits: [
        { runId: 'draft', expiresAt: 1 },
        { runId: 'draft', expiresAt: 2 },
      ],
    },
    { ...current, conversationId: 0 },
    { ...current, cursor: {} },
    { ...current, tools: [] },
    { ...current, history: { ...current.history, annotations: { '1': { secret: true } } } },
  ])
    expect(() => decodeSnapshot(invalid)).toThrow('protocol_mismatch');
  expect(() => decodeHistoryPage({ entries: [], history: current.history, cursor: 'old' })).toThrow(
    'protocol_mismatch',
  );
});

it('detaching and overflowing an observation close only its reader and leave native execution running', async () => {
  let start!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const registry = createRegistry();
  registry.install({
    name: 'fixture',
    tools: [
      defineTool({
        name: 'ignores_cancel',
        description: 'Fixture barrier',
        parameters: Type.Object({}),
        replay: 'safe',
        execute: async (_args, api, context) => {
          start();
          await gate;
          for (let index = 0; index < 100; index++) await api.details({ index }, context);
          return { output: [{ type: 'text', text: 'completed despite observer detach' }] };
        },
      }),
    ],
  });
  const pi = await Harness.open(
    new MemoryStorage(),
    { registry, models: fixtureModels(), settings: { progress: { outputIntervalMs: 0 } } },
    BG,
  );
  try {
    const conversation = await pi.root(BG, {
      agent: { model: { provider: 'fixture', modelId: 'fixture' } },
    });
    const runId = 'observer-detach';
    await conversation.submit({ type: 'input', requestId: runId, content: 'ignores_cancel' }, BG);
    await started;
    const { model } = reader(pi, conversation);
    const detached = await model.open(runId);
    await detached!.close();
    const buffered = await model.open(runId);
    release();
    await conversation.waitForIdle(BG);
    const batches = [];
    for await (const batch of buffered!.frames) batches.push(...batch);
    expect(batches).toEqual([{ type: 'reset' }]);
    expect(
      (await pi.commit((tx) => tx.submissionByRequest(conversation.id, runId), BG))?.status,
    ).toBe('done');
  } finally {
    release();
    await pi.close(BG);
  }
});

it('accepts only the exact visible native resource round, including inherited results before the fork cutoff', async () => {
  const pi = await Harness.open(
    new MemoryStorage(),
    { models: fixtureModels(), registry: createRegistry() },
    BG,
  );
  try {
    const root = await pi.root(BG);
    const appendCall = async () =>
      root.commit(
        async (tx) =>
          (
            await tx.appendEntry(AssistantEntry, root.id, {
              model: [
                {
                  role: 'assistant',
                  content: [
                    {
                      type: 'toolCall',
                      id: 'same-call',
                      name: 'present_openui',
                      arguments: { title: 'Visible' },
                    },
                  ],
                  api: 'openai-responses',
                  provider: 'fixture',
                  model: 'fixture',
                  usage,
                  stopReason: 'toolUse',
                  timestamp: 0,
                },
              ],
            })
          ).id,
        BG,
      );
    const call = await appendCall(),
      ref = `${call}.same-call`;
    const result = await root.commit(
      async (tx) =>
        (
          await tx.appendEntry(ToolResultEntry, root.id, {
            data: { diagnostics: [] },
            model: [
              {
                role: 'toolResult',
                toolName: 'present_openui',
                toolCallId: 'same-call',
                content: [{ type: 'text', text: 'published' }],
                details: { ref, panel: 'public' },
                isError: false,
                timestamp: 0,
              },
            ],
          })
        ).id,
      BG,
    );
    const branch = await root.fork(result, { ownership: { kind: 'ownerless' } }, BG);
    expect(await readSuccessfulTool(pi, branch.id, ref, 'present_openui', BG)).toMatchObject({
      details: { ref, panel: 'public' },
    });
    const hidden = await appendCall();
    expect(
      await readSuccessfulTool(pi, branch.id, `${hidden}.same-call`, 'present_openui', BG),
    ).toBeUndefined();
    expect(
      await readSuccessfulTool(pi, branch.id, `${call}.malformed%`, 'present_openui', BG),
    ).toBeUndefined();
    const cut = await root.fork(call, { ownership: { kind: 'ownerless' } }, BG);
    expect(await readSuccessfulTool(pi, cut.id, ref, 'present_openui', BG)).toBeUndefined();
  } finally {
    await pi.close(BG);
  }
});

it('owns native observation and exposes only bounded materialized frames to the transport', async () => {
  const registry = createRegistry();
  registry.install(
    await nativeSkills([
      {
        id: 'fixture',
        fingerprint: 'v1',
        list: async () => [{ name: 'delivery-guide', description: 'Guide' }],
        load: async () => ({ name: 'delivery-guide', description: 'Guide', body: 'BODY' }),
        readResource: async () => ({
          path: 'references/checklist.md',
          kind: 'reference',
          content: 'RESOURCE',
        }),
      },
    ]),
  );
  const pi = await Harness.open(new MemoryStorage(), { registry, models: fixtureModels() }, BG);
  try {
    const root = await pi.root(BG, {
      agent: { model: { provider: 'fixture', modelId: 'fixture' } },
    });
    const runId = 'native-read-observation';
    await root.submit({ type: 'input', requestId: runId, content: 'custom_skill_probe' }, BG);
    const { model } = reader(pi, root);
    const response = await model.observe(runId, 'thread');
    const body = await response.text();
    expect(body).toContain('RUN_FINISHED');
    expect(body).toContain('BODY');
    expect(body).toContain('RESOURCE');
    expect(body).not.toContain('stream_restore_failed');
    const opened = await model.open(runId);
    expect(Object.keys(opened!)).toEqual(['initial', 'frames', 'close']);
    expect(opened!.initial.at(-1)).toMatchObject({ type: 'terminal', status: 'done' });
    await opened!.close();
  } finally {
    await pi.close(BG);
  }
});
