// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { Panel } from '../../src/extensions/openui/Panel';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('persists native form fields without reactive bindings and submits the click-time snapshot', async () => {
  const saves: { state: unknown; expectedRevision: number }[] = [];
  const submit = vi.fn(async () => {});
  const ui =
    'root = Form("preferences",Buttons([Button("Continue",Action([@ToAssistant("Use my choices")]))]),[FormControl("Topics",CheckBoxGroup("topics",[CheckBoxItem("Budget","Costs","cost"),CheckBoxItem("Timing","Schedule","timing")])),FormControl("Period",RadioGroup("period",[RadioItem("Short","","short"),RadioItem("Long","","long")])),FormControl("Notes",Input("notes","Optional details"))])';
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (_url, init) =>
        new Response(
          JSON.stringify(
            init?.method === 'PATCH'
              ? (saves.push(JSON.parse(init.body)), { revision: saves.length })
              : {
                  ref: '2.native',
                  data: { ui, program: null },
                  state: saves.at(-1)?.state ?? {},
                  revision: saves.length,
                },
          ),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    ),
  );
  let view = render(<Panel conversationId="native-form" panelRef="2.native" submit={submit} />);
  await waitFor(() => expect(view.queryByRole('checkbox', { name: /Budget/ })).not.toBeNull());
  fireEvent.click(view.getByRole('checkbox', { name: /Budget/ }));
  fireEvent.click(view.getByRole('radio', { name: 'Long' }));
  fireEvent.change(view.getByPlaceholderText('Optional details'), {
    target: { value: 'Keep unknowns' },
  });
  await waitFor(() =>
    expect(saves.at(-1)?.state).toEqual({
      preferences: {
        topics: { value: { cost: true, timing: false } },
        period: { value: 'long' },
        notes: { value: 'Keep unknowns' },
      },
    }),
  );
  expect(view.queryByRole('alert')).toBeNull();
  expect(submit).not.toHaveBeenCalled();
  view.unmount();
  view = render(<Panel conversationId="native-form" panelRef="2.native" submit={submit} />);
  await waitFor(() =>
    expect(view.getByRole('radio', { name: 'Long' }).getAttribute('aria-checked')).toBe('true'),
  );
  expect(view.getByRole('checkbox', { name: /Budget/ }).getAttribute('aria-checked')).toBe('true');
  expect((view.getByPlaceholderText('Optional details') as HTMLInputElement).value).toBe(
    'Keep unknowns',
  );
  // A final edit must reach the action even before the autosave debounce flushes.
  fireEvent.change(view.getByPlaceholderText('Optional details'), {
    target: { value: 'Latest edit' },
  });
  fireEvent.click(view.getByRole('button', { name: 'Continue' }));
  expect(submit).toHaveBeenCalledTimes(1);
  expect(submit).toHaveBeenCalledWith(
    'Use my choices',
    expect.objectContaining({
      payload: {
        ref: '2.native',
        state: {
          preferences: {
            topics: { value: { cost: true, timing: false } },
            period: { value: 'long' },
            notes: { value: 'Latest edit' },
          },
        },
      },
    }),
  );
});

function resource(ui: string, ref: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (_url, init) =>
        new Response(
          JSON.stringify(
            init?.method === 'PATCH'
              ? { revision: 1 }
              : { ref, data: { ui, program: null }, state: {}, revision: 0 },
          ),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    ),
  );
}
const actionForm =
  '$note = "Original"\nroot=Form("wait",Buttons([Button("Send",Action([@ToAssistant("Use answers")])),Button("Alternative",{type:"continue_conversation"}),Button("Reset",Action([@Reset($note)]),"secondary")]),[FormControl("Note",Input("note","Details","text",null,$note))])';

it('shows loading only on the clicked action, blocks duplicate messages, and preserves local edits until acceptance', async () => {
  resource(actionForm, '2.wait');
  let accept!: () => void;
  const submit = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        accept = resolve;
      }),
  );
  const view = render(<Panel conversationId="loading-form" panelRef="2.wait" submit={submit} />);
  const send = await view.findByRole('button', { name: 'Send' });
  const alternative = view.getByRole('button', { name: 'Alternative' });
  fireEvent.change(view.getByPlaceholderText('Details'), { target: { value: 'Submitted' } });
  fireEvent.click(send);
  expect(send.getAttribute('aria-busy')).toBe('true');
  expect(send.querySelector('.animate-spin')).not.toBeNull();
  expect(send).toHaveProperty('disabled', true);
  expect(alternative.getAttribute('aria-busy')).toBeNull();
  expect(alternative).toHaveProperty('disabled', true);
  fireEvent.click(send);
  fireEvent.click(alternative);
  expect(submit).toHaveBeenCalledTimes(1);
  const reset = view.getByRole('button', { name: 'Reset' });
  expect(reset).toHaveProperty('disabled', false);
  fireEvent.click(reset);
  expect(view.getByPlaceholderText('Details')).toHaveProperty('value', 'Original');
  expect(submit.mock.calls[0]).toEqual([
    'Use answers',
    expect.objectContaining({
      payload: {
        ref: '2.wait',
        state: { $note: 'Submitted' },
      },
    }),
  ]);
  await act(async () => accept());
  expect(send).toHaveProperty('disabled', false);
  expect(send.getAttribute('aria-busy')).toBeNull();
  expect(send.querySelector('.animate-spin')).toBeNull();
  expect(alternative).toHaveProperty('disabled', false);
});

it('clears loading after rejection, keeps the draft, and allows explicit retry', async () => {
  resource(actionForm, '2.rejected');
  let reject!: (error: Error) => void;
  const submit = vi.fn(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      }),
  );
  const view = render(<Panel conversationId="failed-form" panelRef="2.rejected" submit={submit} />);
  const send = await view.findByRole('button', { name: 'Send' });
  fireEvent.change(view.getByPlaceholderText('Details'), { target: { value: 'Keep this' } });
  fireEvent.click(send);
  await act(async () => reject(new Error('Request failed')));
  expect(view.getByRole('alert').textContent).toBe('Request failed');
  expect(send).toHaveProperty('disabled', false);
  expect(send.getAttribute('aria-busy')).toBeNull();
  expect(view.getByPlaceholderText('Details')).toHaveProperty('value', 'Keep this');
  submit.mockResolvedValueOnce();
  fireEvent.click(send);
  await waitFor(() => expect(send).toHaveProperty('disabled', false));
  expect(submit).toHaveBeenCalledTimes(2);
  expect(view.queryByRole('alert')).toBeNull();
});

it('leaves invalid forms idle and only enters loading after native validation succeeds', async () => {
  resource(
    'root=Form("required",Buttons([Button("Submit",Action([@ToAssistant("Continue")]))]),[FormControl("Name",Input("name","Required name","text",{required:true}))])',
    '2.required',
  );
  let accept!: () => void;
  const submit = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        accept = resolve;
      }),
  );
  const view = render(
    <Panel conversationId="validation-form" panelRef="2.required" submit={submit} />,
  );
  const button = await view.findByRole('button', { name: 'Submit' });
  fireEvent.click(button);
  expect(submit).not.toHaveBeenCalled();
  expect(button.getAttribute('aria-busy')).toBeNull();
  expect(button).toHaveProperty('disabled', false);
  fireEvent.change(view.getByPlaceholderText('Required name'), { target: { value: 'Ada' } });
  fireEvent.click(button);
  expect(submit).toHaveBeenCalledTimes(1);
  expect(button.getAttribute('aria-busy')).toBe('true');
  await act(async () => accept());
});
