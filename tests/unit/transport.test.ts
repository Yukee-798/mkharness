import { partialUI } from '../../src/extensions/openui/partial';
import { it, expect, vi } from 'vitest';
import { AttachAgent } from '../../src/browser/transport';
it('only attaches with GET; abort detaches without POST or stop', async () => {
  const requests: RequestInit[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => {
      requests.push(init);
      return new Response(
        'data: {"type":"RUN_STARTED","threadId":"c","runId":"r"}\n\ndata: {"type":"RUN_FINISHED","threadId":"c","runId":"r"}\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    }),
  );
  const agent = new AttachAgent(
    'c',
    () => {},
    () => {},
  );
  await new Promise<void>((resolve, reject) =>
    agent
      .run({ forwardedProps: { runConfig: { mode: 'attach', runId: 'r' } } } as any)
      .subscribe({ complete: resolve, error: reject }),
  );
  agent.abortRun();
  expect(requests).toHaveLength(1);
  expect(requests[0].method ?? 'GET').toBe('GET');
  expect(requests[0].body).toBeUndefined();
  vi.unstubAllGlobals();
});
it('extracts partial UI across quotes, backslashes and Unicode escape boundaries', () => {
  const expected = 'root = Text("text","C:\\tmp 你好😀")';
  const encoded = JSON.stringify({ ui: expected });
  for (let i = 1; i <= encoded.length; i++) {
    const value = partialUI(encoded.slice(0, i));
    if (value !== undefined) expect(expected.startsWith(value)).toBe(true);
  }
  expect(partialUI(encoded)).toBe(expected);
});
it('committed progress rejects foreign-run and older projections; no execution is initiated', async () => {
  const progress = vi.fn();
  const remote = [
    { taskId: 3, runId: 'r', status: 'waiting', remoteStatus: 'pending', deadline: 100 },
  ];
  const events = [
    { type: 'RUN_STARTED', threadId: 'c', runId: 'r' },
    { type: 'STATE_SNAPSHOT', snapshot: { runId: 'foreign', remoteRevision: 99, remote } },
    { type: 'STATE_SNAPSHOT', snapshot: { runId: 'r', remoteRevision: 8, remote } },
    { type: 'STATE_SNAPSHOT', snapshot: { runId: 'r', remoteRevision: 7, remote: [] } },
    { type: 'RUN_FINISHED', threadId: 'c', runId: 'r' },
  ];
  const network = vi.fn(
    async () =>
      new Response(events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join(''), {
        headers: { 'Content-Type': 'text/event-stream' },
      }),
  );
  vi.stubGlobal('fetch', network);
  try {
    const agent = new AttachAgent(
      'c',
      () => {},
      () => {},
      () => {},
      progress,
    );
    await new Promise<void>((resolve, reject) =>
      agent
        .run({ forwardedProps: { runConfig: { mode: 'attach', runId: 'r' } } } as any)
        .subscribe({ complete: resolve, error: reject }),
    );
    expect(progress).toHaveBeenCalledExactlyOnceWith('r', remote);
    expect(network).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
  }
});
it('cloned observations retain committed identities across runs without accepting foreign or replacement aliases', async () => {
  const ids = new Map([['2', 'draft:earlier:1']]);
  const toolProgress = vi.fn();
  const events = [
    { type: 'RUN_STARTED', threadId: 'c', runId: 'r' },
    {
      type: 'STATE_SNAPSHOT',
      snapshot: { runId: 'foreign', messageIds: { '4': 'draft:foreign:1' } },
    },
    {
      type: 'STATE_SNAPSHOT',
      snapshot: {
        runId: 'r',
        messageIds: { '2': 'draft:r:wrong', '4': 'draft:r:1' },
        toolProgress: { '2.same.with.dot': { status: 'running' } },
      },
    },
    {
      type: 'MESSAGES_SNAPSHOT',
      messages: [
        { id: '2:reasoning:0', role: 'reasoning', content: 'Earlier thinking' },
        {
          id: '2',
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: '2.same.with.dot', type: 'function', function: { name: 'x', arguments: '{}' } },
          ],
        },
        { id: '3', role: 'tool', toolCallId: '2.same.with.dot', content: 'done' },
        { id: '4:reasoning:0', role: 'reasoning', content: 'Current thinking' },
        { id: '4', role: 'assistant', content: 'Current answer' },
      ],
    },
    {
      type: 'TOOL_CALL_RESULT',
      messageId: '5',
      role: 'tool',
      toolCallId: '2.same.with.dot',
      content: 'settled after reattachment',
    },
    { type: 'RUN_FINISHED', threadId: 'c', runId: 'r' },
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
          headers: { 'Content-Type': 'text/event-stream' },
        }),
    ),
  );
  try {
    const agent = new AttachAgent(
      'c',
      () => {},
      () => {},
      () => {},
      () => {},
      ids,
      toolProgress,
    );
    const observed: any[] = [];
    await new Promise<void>((resolve, reject) =>
      agent
        .clone()
        .run({ forwardedProps: { runConfig: { mode: 'attach', runId: 'r' } } } as any)
        .subscribe({ next: (event) => observed.push(event), complete: resolve, error: reject }),
    );
    expect(toolProgress).toHaveBeenCalledWith('r', {
      'draft:earlier:1.same.with.dot': { status: 'running' },
    });
    expect([...ids]).toEqual([
      ['2', 'draft:earlier:1'],
      ['4', 'draft:r:1'],
    ]);
    expect(observed.find((event) => event.type === 'MESSAGES_SNAPSHOT').messages).toMatchObject([
      { id: 'draft:earlier:1:reasoning:0' },
      { id: 'draft:earlier:1', toolCalls: [{ id: 'draft:earlier:1.same.with.dot' }] },
      { id: '3', toolCallId: 'draft:earlier:1.same.with.dot' },
      { id: 'draft:r:1:reasoning:0' },
      { id: 'draft:r:1' },
    ]);
    expect(observed.find((event) => event.type === 'TOOL_CALL_RESULT')).toMatchObject({
      messageId: '5',
      toolCallId: 'draft:earlier:1.same.with.dot',
    });
  } finally {
    vi.unstubAllGlobals();
  }
});
