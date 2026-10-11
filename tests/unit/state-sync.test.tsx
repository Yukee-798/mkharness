// @vitest-environment jsdom
import { it, expect } from 'vitest';
import { render, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { Renderer } from '@openuidev/react-lang';
import { library, PanelContext, type PanelGuard } from '../../src/extensions/openui/catalog';
const code = (sync: boolean) =>
  `$cost = "10"\nresult = Query("run_program",{cost:$cost},{next:0,ready:false})\nroot = Stack([Input("cost","Cost","number",null,$cost),Button("Preset",Action([@Set($cost,"30")])),Button("Reset",Action([@Reset($cost)]))${sync ? ',StateSync($cost,result.next,result.ready)' : ''}])`;
it('keeps raw strings and native Set/Reset, including unfinished numeric edits', async () => {
  let state: Record<string, unknown> = {};
  const view = render(
    <Renderer
      response={code(false)}
      library={library}
      initialState={{ $cost: '' }}
      onStateUpdate={(s) => (state = s)}
      toolProvider={{ run_program: async () => ({ next: 20, ready: true }) }}
    />,
  );
  const input = view.getByPlaceholderText('Cost');
  expect((input as HTMLInputElement).value).toBe('');
  fireEvent.change(input, { target: { value: '12' } });
  expect(state.$cost).toBe('12');
  fireEvent.click(view.getByText('Preset'));
  expect(state.$cost).toBe('30');
  fireEvent.click(view.getByText('Reset'));
  expect(state.$cost).toBe('10');
  cleanup();
});
it('ablation: derived values stay separate without StateSync and write back with it', async () => {
  for (const enabled of [false, true]) {
    let state: Record<string, unknown> = { $cost: '10' };
    const guard: PanelGuard = { epoch: 0, ready: true, halted: false, report: () => {} };
    const view = render(
      <PanelContext value={guard}>
        <Renderer
          response={code(enabled)}
          library={library}
          onStateUpdate={(s) => (state = s)}
          toolProvider={{ run_program: async () => ({ next: 20, ready: true }) }}
        />
      </PanelContext>,
    );
    await waitFor(() => expect(state.$cost).toBe(enabled ? 20 : '10'));
    view.unmount();
  }
});
it('halts a non-converging automatic chain after three writes without touching another panel', async () => {
  const errors: string[] = [];
  let state: Record<string, unknown> = { $cost: '10' };
  const guard: PanelGuard = { epoch: 0, ready: true, halted: false, report: (m) => errors.push(m) };
  const view = render(
    <PanelContext value={guard}>
      <Renderer
        response={code(true)}
        library={library}
        onStateUpdate={(s) => (state = s)}
        toolProvider={{
          run_program: async (args) => ({ next: Number(args.cost) + 1, ready: true }),
        }}
      />
    </PanelContext>,
  );
  await waitFor(() => expect(errors).toHaveLength(1));
  expect(state.$cost).toBe(13);
  expect(guard.halted).toBe(true);
  view.unmount();
});
