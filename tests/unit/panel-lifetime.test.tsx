// @vitest-environment jsdom
import { it, expect, vi, afterEach } from 'vitest';
import { render, waitFor, fireEvent, act, cleanup } from '@testing-library/react';
import { Panel } from '../../src/extensions/openui/Panel';
const pending = vi.hoisted(
  () => [] as { id: string; inputs: any; signal?: AbortSignal; resolve: (value: any) => void }[],
);
vi.mock('../../src/browser/compute', () => ({
  computeProgram: vi.fn(
    (program, inputs, signal) =>
      new Promise((resolve) => pending.push({ id: program.data, inputs, signal, resolve })),
  ),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  pending.length = 0;
});
it('keeps computation alive on a non-editing click and isolates late results after edit/unmount', async () => {
  const saved: any[] = [];
  const ui =
    '$choice = "A"\n$target = ""\nresult = Query("run_program",{choice:$choice},{next:"",ready:false})\nroot = Stack([Text("text","Details"),Input("choice","Choice","text",null,$choice),Input("target","Target","text",null,$target),StateSync($target,result.next,result.ready,{result:result,inputs:{choice:$choice}})])';
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url, init) =>
        new Response(
          JSON.stringify(
            init?.method === 'PATCH'
              ? (saved.push(JSON.parse(init.body)), { revision: saved.length })
              : {
                  ref: '2.same',
                  data: {
                    ui,
                    program: {
                      code: 'unused',
                      data: String(url).includes('/one/') ? 'one' : 'two',
                    },
                  },
                  revision: 0,
                },
          ),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    ),
  );
  const view = render(
    <>
      <Panel conversationId="one" panelRef="2.same" submit={async () => {}} />
      <Panel conversationId="two" panelRef="2.same" submit={async () => {}} />
    </>,
  );
  await waitFor(() => expect(pending.filter((p) => p.id === 'two')).not.toHaveLength(0));
  fireEvent.click(view.getAllByText('Details')[0]!);
  await act(async () =>
    pending
      .filter((p) => p.id === 'one')
      .forEach((p) => p.resolve({ ok: true, value: { next: 'A', ready: true } })),
  );
  await waitFor(() =>
    expect((view.getAllByPlaceholderText('Target')[0] as HTMLInputElement).value).toBe('A'),
  );
  fireEvent.change(view.getAllByPlaceholderText('Choice')[0]!, { target: { value: 'B' } });
  await waitFor(() => expect(pending.filter((p) => p.inputs.choice === 'B')).not.toHaveLength(0));
  fireEvent.change(view.getAllByPlaceholderText('Choice')[0]!, { target: { value: 'C' } });
  await waitFor(() => expect(pending.filter((p) => p.inputs.choice === 'C')).not.toHaveLength(0));
  expect(pending.filter((p) => p.inputs.choice === 'B').every((p) => p.signal?.aborted)).toBe(true);
  await act(async () => {
    pending
      .filter((p) => p.inputs.choice === 'B' || p.id === 'two')
      .forEach((p) => p.resolve({ ok: true, value: { next: p.inputs.choice, ready: true } }));
  });
  expect((view.getAllByPlaceholderText('Target')[0] as HTMLInputElement).value).toBe('A');
  await waitFor(() =>
    expect((view.getAllByPlaceholderText('Target')[1] as HTMLInputElement).value).toBe('A'),
  );
  view.unmount();
  expect(pending.filter((p) => p.inputs.choice === 'C').every((p) => p.signal?.aborted)).toBe(true);
  const before = saved.length;
  await act(async () =>
    pending
      .filter((p) => p.inputs.choice === 'C')
      .forEach((p) => p.resolve({ ok: true, value: { next: 'C', ready: true } })),
  );
  expect(saved).toHaveLength(before);
});
