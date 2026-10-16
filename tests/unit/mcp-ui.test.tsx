// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ToolCallMessagePartProps } from '@assistant-ui/react';
import { McpConnections } from '../../src/extensions/mcp/Settings';
import { ExtensionContext } from '../../src/browser/extensions/extension-context';
import {
  ToolFooterExtensions,
  ComposerFooterExtensions,
} from '../../src/browser/extensions/extension-ui';
import { ui } from '../../src/extensions/mcp/browser';
import { ui as skillsUi } from '../../src/extensions/skills/browser';
import { connectionState } from '../../src/extensions/mcp/manager';
import type { ConnectionView } from '../../src/shared/mcp-connections';
import type { McpRequest } from '../../src/server/mcp/connections/requests';

const connection: ConnectionView = {
  id: 'remote',
  name: 'Documents',
  endpoint: 'https://remote.example.test/mcp',
  auth: 'auto',
  enabled: true,
  status: 'ready',
  revision: 4,
  grant: 1,
  tools: [
    {
      name: 'read_document',
      description: 'Read a document',
      schema: { type: 'object' },
      supported: true,
      permission: 'ask',
      hash: 'schema',
    },
  ],
};
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function directory() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <McpConnections userId="owner" />
    </QueryClientProvider>,
  );
  return { ...view, client };
}
it.each(['bearer', 'oauth'] as const)(
  'uses official form state with server-only %s creation and connect',
  async (auth) => {
    let rows: ConnectionView[] = [];
    const calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: String(url), method, body });
      if (method === 'GET') return Response.json({ connections: rows });
      if (String(url).endsWith('/connect')) return Response.json({ connection: rows[0] });
      rows = [{ ...connection, auth: auth === 'oauth' ? 'auto' : 'bearer' }];
      return Response.json({ connection: rows[0] });
    });
    const view = directory();
    await view.findByText('No connections yet.');
    fireEvent.click(view.getByRole('button', { name: 'Add connection' }));
    fireEvent.change(view.getByLabelText('Connection name'), { target: { value: 'Documents' } });
    fireEvent.change(view.getByLabelText('Server URL'), { target: { value: connection.endpoint } });
    fireEvent.change(view.getByLabelText('Authentication'), { target: { value: auth } });
    if (auth === 'bearer') {
      const token = view.getByLabelText('Bearer token') as HTMLInputElement;
      expect(token.type).toBe('password');
      fireEvent.change(token, { target: { value: 'fixture-bearer-secret' } });
    } else {
      fireEvent.click(view.getByRole('button', { name: 'Advanced OAuth settings' }));
      const clientId = view.getByLabelText('Client ID');
      clientId.focus();
      fireEvent.change(clientId, { target: { value: 'fixture-client' } });
      expect(view.getByLabelText('Client ID')).toBe(clientId);
      expect(document.activeElement).toBe(clientId);
      const clientSecret = view.getByLabelText('Client secret');
      fireEvent.change(clientSecret, {
        target: { value: 'fixture-client-secret' },
      });
      expect(view.getByLabelText('Client secret')).toBe(clientSecret);
    }
    fireEvent.click(view.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith('/connect'))).toHaveLength(1));
    expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/connections'))?.body).toEqual({
      name: 'Documents',
      endpoint: connection.endpoint,
      auth: auth === 'oauth' ? 'auto' : 'bearer',
      ...(auth === 'bearer'
        ? { token: 'fixture-bearer-secret' }
        : { clientId: 'fixture-client', clientSecret: 'fixture-client-secret' }),
    });
    expect(calls.every((c) => c.url.startsWith('/api/mcp/connections'))).toBe(true);
    expect(storage).not.toHaveBeenCalled();
    expect(
      JSON.stringify(view.client.getQueryData(['user', 'owner', 'mcp-connections'])),
    ).not.toContain('secret');
    expect(view.queryByLabelText('Client secret')).toBeNull();
    fireEvent.click(view.getByRole('button', { name: 'Add connection' }));
    expect((view.getByLabelText('Connection name') as HTMLInputElement).value).toBe('');
  },
);
it('keeps delete confirmation and reconnect errors in the server-backed directory', async () => {
  let row = { ...connection, enabled: false };
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    if (method === 'GET') return Response.json({ connections: [row] });
    if (method === 'PATCH') {
      row = { ...row, enabled: true };
      return Response.json({ connection: row });
    }
    if (String(url).endsWith('/connect'))
      return Response.json({ error: { message: 'Please reconnect' } }, { status: 409 });
    return Response.json({ ok: true });
  });
  const view = directory();
  fireEvent.click(await view.findByRole('button', { name: 'Connect' }));
  await view.findByText('Please reconnect');
  expect(calls.indexOf('PATCH /api/mcp/connections/remote')).toBeLessThan(
    calls.indexOf('POST /api/mcp/connections/remote/connect'),
  );
  const remove = view.getByRole('button', { name: 'Disconnect Documents' }) as HTMLButtonElement;
  await waitFor(() => expect(remove.disabled).toBe(false));
  fireEvent.click(remove);
  expect(calls).not.toContain('DELETE /api/mcp/connections/remote');
  fireEvent.click(
    within(view.getByRole('alertdialog')).getByRole('button', { name: 'Disconnect' }),
  );
  await waitFor(() => expect(calls).toContain('DELETE /api/mcp/connections/remote'));
});
it('projects only supported and enabled tools into the presentation scope', () => {
  const state = connectionState({
    ...connection,
    tools: [
      connection.tools[0]!,
      { ...connection.tools[0]!, name: 'disabled', permission: 'disabled' },
      { ...connection.tools[0]!, name: 'unsupported', supported: false },
    ],
  });
  expect(state.tools.map((t) => t.name)).toEqual(['read_document']);
  expect(state.authorizationUrl).toBeNull();
  expect(state).not.toHaveProperty('auth');
});

type RequestView = McpRequest & { toolCallId?: string };
function approval(parentId: number, toolCallId: string): RequestView {
  return {
    taskId: parentId + 100,
    parentId,
    toolCallId,
    connectionId: 'remote',
    connectionName: 'Documents',
    toolName: 'read_document',
    args: JSON.stringify({ query: `document-${parentId}` }),
    status: 'pending',
    deadline: Date.now() + 60000,
  };
}
function Approvals({ requests }: { requests: RequestView[] }) {
  const part = (id: string) =>
    ({
      toolCallId: id,
      toolName: 'mcp_remote_read',
      type: 'tool-call',
      args: {},
      argsText: '{}',
    }) as ToolCallMessagePartProps;
  return (
    <ExtensionContext
      value={{
        id: 'chat',
        userId: 'owner',
        submit: async () => {},
        toolkit: {},
        activity: {},
        ui: [
          { id: 'mcp', ...ui },
          { id: 'skills', ...skillsUi },
        ],
        messageIds: new Map([['20', 'live']]),
        state: {
          mcp: { requests, connections: [{ id: 'remote', name: 'Documents' }] },
          skills: {
            available: [
              { id: 'guide', name: 'delivery-guide', description: 'Guide', version: 'v1' },
            ],
            loaded: [{ id: 'guide', name: 'delivery-guide', version: 'v1', entryId: 1 }],
          },
        },
      }}
    >
      <section aria-label="first">
        <ToolFooterExtensions part={part('live.same')} />
      </section>
      <section aria-label="second">
        <ToolFooterExtensions part={part('30.same')} />
      </section>
      <section aria-label="composer">
        <ComposerFooterExtensions />
      </section>
    </ExtensionContext>
  );
}
it('binds same-name approvals to canonical tool IDs and waits for authoritative state after one decision', async () => {
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({ accepted: true }));
  const first = approval(50, '20.same'),
    second = approval(60, '30.same');
  const view = render(<Approvals requests={[first, second]} />);
  const a = within(view.getByRole('region', { name: 'first' })),
    b = within(view.getByRole('region', { name: 'second' }));
  expect(a.getByText(/document-50/)).toBeTruthy();
  expect(b.getByText(/document-60/)).toBeTruthy();
  expect(view.getByRole('region', { name: 'composer' }).textContent).toBe('');
  const allow = b.getByRole('button', { name: 'Allow once' }) as HTMLButtonElement;
  fireEvent.click(allow);
  fireEvent.click(allow);
  await waitFor(() => expect(network).toHaveBeenCalledTimes(1));
  expect(network).toHaveBeenCalledWith(
    '/api/conversations/chat/extensions/mcp/controls/decide',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ parentId: 60, decision: 'approved' }),
    }),
  );
  expect(allow.disabled).toBe(true);
  expect((a.getByRole('button', { name: 'Allow once' }) as HTMLButtonElement).disabled).toBe(false);
  view.rerender(<Approvals requests={[first, { ...second, status: 'dispatching' }]} />);
  expect(b.getByRole('status').textContent).toContain('Approved, running');
  expect(b.queryByRole('button')).toBeNull();
  view.rerender(<Approvals requests={[first, { ...second, status: 'completed' }]} />);
  expect(b.queryByRole('group')).toBeNull();
});
it('keeps uncertain outcomes non-actionable and expired decisions disabled', () => {
  const first = { ...approval(50, '20.same'), deadline: Date.now() - 1 };
  const second = { ...approval(60, '30.same'), status: 'unknown' as const };
  const view = render(<Approvals requests={[first, second]} />);
  const a = within(view.getByRole('region', { name: 'first' })),
    b = within(view.getByRole('region', { name: 'second' }));
  expect(a.getByText('This approval has expired.')).toBeTruthy();
  expect((a.getByRole('button', { name: 'Allow once' }) as HTMLButtonElement).disabled).toBe(true);
  expect(b.getByRole('status').textContent).toContain('will not be replayed automatically');
  expect(b.queryByRole('button')).toBeNull();
});
it('keeps an unbound pending approval visible without a connection or skill summary', () => {
  const { toolCallId: _toolCallId, ...pending } = approval(70, '');
  const view = render(<Approvals requests={[pending]} />);
  const composer = within(view.getByRole('region', { name: 'composer' }));
  expect(composer.getByRole('button', { name: 'Allow once' })).toBeTruthy();
  expect(composer.queryByText('Tools in this chat')).toBeNull();
  expect(composer.queryByText('Skills in this chat')).toBeNull();
  expect(composer.queryByText('delivery-guide')).toBeNull();
});
