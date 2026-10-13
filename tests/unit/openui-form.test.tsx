// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
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
