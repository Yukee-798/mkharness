// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import {
  AuiConfig,
  AssistantRuntimeProvider,
  MessageByIndexProvider,
  MessagePrimitive,
  Tools,
  useExternalStoreRuntime,
} from '@assistant-ui/react';

const workspace = vi.hoisted(() => ({ openObject: vi.fn(), setOpen: vi.fn() }));
vi.mock('../../src/browser/workspace/provider', () => ({ useWorkspace: () => workspace }));
import { LocaleProvider, useLocale } from '../../src/browser/app/locale';
import { toolkit } from '../../src/browser/workspace/extension';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});
function SwitchLanguage() {
  const { setLocale } = useLocale();
  return <button onClick={() => setLocale('en')}>English</button>;
}
const config = AuiConfig({ tools: Tools({ toolkit }) });
function App({ summary, failed = false }: { summary?: string; failed?: boolean }) {
  const args = {
    name: 'report.publish',
    input: {
      title: '2026 年市场分析报告',
      ...(summary ? { summary } : {}),
      source: '<h1>报告</h1>',
    },
  };
  const runtime = useExternalStoreRuntime({
    messages: [
      {
        id: 'message',
        role: 'assistant' as const,
        status: { type: 'complete' as const, reason: 'stop' as const },
        content: [
          {
            type: 'tool-call' as const,
            toolName: 'workspace_execute',
            toolCallId: 'report',
            args,
            argsText: JSON.stringify(args),
            result: failed
              ? 'report_validation_failed'
              : JSON.stringify({
                  command: 'report.publish',
                  status: 'committed',
                  objectIds: ['R1'],
                }),
            isError: failed,
          },
        ],
      },
    ],
    convertMessage: (message) => message,
    onNew: async () => {},
  });
  return (
    <LocaleProvider initialLocale="zh-CN">
      <SwitchLanguage />
      <AssistantRuntimeProvider runtime={runtime} config={config}>
        <MessageByIndexProvider index={0}>
          <MessagePrimitive.Parts />
        </MessageByIndexProvider>
      </AssistantRuntimeProvider>
    </LocaleProvider>
  );
}

it('renders report metadata in the registered tool card and opens the saved report', async () => {
  const page = render(<App summary="对市场规模、增长趋势与竞争格局进行分析。" />);
  await waitFor(() =>
    expect(page.queryByRole('heading', { name: '2026 年市场分析报告' })).not.toBeNull(),
  );
  expect(page.getByText('对市场规模、增长趋势与竞争格局进行分析。')).toBeDefined();
  expect(page.getByRole('status').textContent).toContain('已保存');
  fireEvent.click(page.getByRole('button', { name: '查看报告' }));
  expect(workspace.openObject).toHaveBeenCalledWith('R1');
});

it('keeps old report results without a summary readable', async () => {
  const page = render(<App />);
  await waitFor(() =>
    expect(page.queryByRole('heading', { name: '2026 年市场分析报告' })).not.toBeNull(),
  );
  expect(page.getByText('打开报告查看完整内容，或下载 HTML 文件。')).toBeDefined();
});

it('does not offer an unsaved report after a tool failure', async () => {
  const page = render(<App failed />);
  await waitFor(() => expect(page.getByRole('status').textContent).toContain('报告未保存'));
  expect(page.queryByRole('button', { name: '查看报告' })).toBeNull();
});

it('switches existing report chrome without changing the report title, summary or tool result', async () => {
  const page = render(<App summary="用户的报告简介保持原文。" />);
  await page.findByRole('button', { name: '查看报告' });
  fireEvent.click(page.getByText('English'));
  expect(page.getByRole('button', { name: 'View report' })).toBeDefined();
  expect(page.getByRole('status').textContent).toContain('Saved');
  expect(page.getByRole('heading', { name: '2026 年市场分析报告' })).toBeDefined();
  expect(page.getByText('用户的报告简介保持原文。')).toBeDefined();
  expect(workspace.openObject).not.toHaveBeenCalled();
});
