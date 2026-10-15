// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Skills } from '../../src/browser/Skills';
import { SkillPicker, useSkillSelection } from '../../src/extensions/skills/selection';
import { skillQueryKey } from '../../src/extensions/skills/queries';
import { useSubmission } from '../../src/browser/use-submission';
import type { SkillPreview, SkillView } from '../../src/shared/skills';
const preview: SkillPreview = {
  name: 'delivery-guide',
  description: 'Prepare a summary',
  body: 'Review evidence first.',
  version: 'a'.repeat(64),
  warnings: ['Scripts are stored as files and cannot be executed.'],
  files: [{ path: 'SKILL.md', size: 100, kind: 'file', encoding: 'text', sha256: 'hash' }],
};
const skill: SkillView = { ...preview, id: 'guide', enabled: true, revision: 3, updatedAt: 1 };
beforeEach(() =>
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  ),
);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function renderLibrary() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Skills userId="owner" />
    </QueryClientProvider>,
  );
}
it.each([{ selected: [] }, { selected: ['guide'] }])(
  'preserves explicit skill selection $selected after a failed background refresh',
  async ({ selected }) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(skillQueryKey('owner'), { skills: [skill] });
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ skills: [skill] }));
    const { result } = renderHook(() => useSkillSelection('owner', true), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    act(() => result.current.setSelected(selected));
    network.mockRejectedValue(new Error('temporary directory failure'));
    await act(async () => {
      await client.refetchQueries({ queryKey: skillQueryKey('owner') });
    });
    await waitFor(() => expect(result.current.query.isError).toBe(true));
    expect(result.current.creationIds).toEqual(selected);
    client.clear();
  },
);
it('previews an uploaded package before publication and keeps the library free of instruction bodies', async () => {
  let rows: SkillView[] = [];
  const calls: { url: string; method: string; body?: BodyInit | null }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: String(url), method, body: init?.body });
    if (method === 'GET') return Response.json({ skills: rows });
    if (String(url).includes('/preview')) return Response.json({ preview });
    rows = [skill];
    return Response.json({ skill });
  });
  const view = renderLibrary();
  await view.findByText('No skills yet.');
  fireEvent.click(view.getByRole('button', { name: 'Import skill' }));
  const file = new File(['skill archive'], 'delivery-guide.zip', { type: 'application/zip' });
  fireEvent.change(view.getByLabelText('Skill file'), { target: { files: [file] } });
  await view.findByText('Review evidence first.');
  expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  fireEvent.click(view.getByRole('button', { name: 'Save skill' }));
  await view.findByRole('button', { name: 'View skill' });
  const write = calls.find((c) => c.url === '/api/skills?filename=delivery-guide.zip');
  expect(write?.body).toBe(file);
  expect(view.queryByText('Review evidence first.')).toBeNull();
  expect(view.getByText('Scripts are stored as files and cannot be executed.')).toBeTruthy();
});
it('requires delete confirmation and supplies the current revision', async () => {
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (_url, init) =>
      Response.json(init?.method === 'DELETE' ? { deleted: true } : { skills: [skill] }),
    );
  const view = renderLibrary();
  fireEvent.click(await view.findByRole('button', { name: 'Delete skill delivery-guide' }));
  expect(network.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  fireEvent.click(
    within(view.getByRole('alertdialog')).getByRole('button', { name: 'Delete skill' }),
  );
  await waitFor(() =>
    expect(network.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true),
  );
  expect(network).toHaveBeenCalledWith(
    '/api/skills/guide',
    expect.objectContaining({ body: JSON.stringify({ revision: 3 }), method: 'DELETE' }),
  );
});
it('selects skills for a new chat without mutating account defaults', () => {
  const change = vi.fn(),
    network = vi.spyOn(globalThis, 'fetch');
  const view = render(
    <SkillPicker
      available={[skill]}
      ids={['guide']}
      onChange={change}
      disabled={false}
      loading={false}
      failed={false}
    />,
  );
  fireEvent.click(view.getByRole('button', { name: 'Skills · 1' }));
  fireEvent.click(view.getByRole('checkbox'));
  expect(change).toHaveBeenCalledWith([]);
  expect(network).not.toHaveBeenCalled();
});
function Send({ ids }: { ids: string[] }) {
  const { send } = useSubmission('owner', '', undefined, { skillIds: ids });
  return <button onClick={() => void send('Use my selected skills')}>Send</button>;
}
it('freezes the selected creation options with the conversation, including an explicit empty selection', async () => {
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (url) =>
      Response.json(String(url) === '/api/conversations' ? { id: 'chat' } : { accepted: true }),
    );
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <Send ids={[]} />
    </QueryClientProvider>,
  );
  fireEvent.click(view.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(network.mock.calls).toHaveLength(2));
  expect(network).toHaveBeenCalledWith(
    '/api/conversations',
    expect.objectContaining({ method: 'POST', body: '{"skillIds":[]}' }),
  );
  expect(network.mock.calls[1]?.[0]).toBe('/api/conversations/chat/runs');
});
