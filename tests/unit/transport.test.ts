import { it, expect, vi } from 'vitest';
import { AttachAgent, partialUI } from '../../src/browser/transport';
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
