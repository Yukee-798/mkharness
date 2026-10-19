// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import {
  AuiConfig,
  AssistantRuntimeProvider,
  MessageByIndexProvider,
  MessagePrimitive,
  Tools,
  useExternalStoreRuntime,
  type MessageStatus,
} from '@assistant-ui/react';
import { LocaleProvider } from '../../src/browser/app/locale';
import { ExtensionContext } from '../../src/browser/extensions/extension-context';
import { toolkit } from '../../src/extensions/images/browser';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const config = AuiConfig({ tools: Tools({ toolkit }) });
const imageResult = {
  ref: '2.image',
  title: 'Orange robot',
  images: [{ file: 'image-1.png', mediaType: 'image/png', bytes: 2048 }],
};
function App({
  status,
  busy = true,
  result,
  isError,
}: {
  status: MessageStatus;
  busy?: boolean;
  result?: unknown;
  isError?: boolean;
}) {
  const runtime = useExternalStoreRuntime({
    messages: [
      {
        id: 'message',
        role: 'assistant' as const,
        status,
        content: [
          {
            type: 'tool-call' as const,
            toolName: 'generate_image',
            toolCallId: 'image',
            args: { prompt: 'An orange robot' },
            argsText: '{"prompt":"An orange robot"}',
            ...(result === undefined ? {} : { result }),
            ...(isError === undefined ? {} : { isError }),
          },
        ],
      },
    ],
    convertMessage: (message) => message,
    onNew: async () => {},
  });
  return (
    <LocaleProvider initialLocale="zh-CN">
      <ExtensionContext
        value={{ id: 'chat', userId: 'owner', submit: async () => {}, busy, toolkit, activity: {} }}
      >
        <AssistantRuntimeProvider runtime={runtime} config={config}>
          <MessageByIndexProvider index={0}>
            <MessagePrimitive.Parts />
          </MessageByIndexProvider>
        </AssistantRuntimeProvider>
      </ExtensionContext>
    </LocaleProvider>
  );
}
it('keeps the real registered image renderer visible after argument streaming ends and replaces it with the image result', async () => {
  const view = render(<App status={{ type: 'running' }} />);
  await waitFor(() => expect(view.queryByText('正在生成图片…')).not.toBeNull());
  view.rerender(<App status={{ type: 'requires-action', reason: 'tool-calls' }} />);
  await waitFor(() => expect(view.queryByText('正在生成图片…')).not.toBeNull());
  // Restored history marks the model message complete while the server-owned run is still busy.
  view.rerender(<App status={{ type: 'complete', reason: 'stop' }} />);
  await waitFor(() => expect(view.queryByText('正在生成图片…')).not.toBeNull());
  view.rerender(
    <App status={{ type: 'complete', reason: 'stop' }} busy={false} result={imageResult} />,
  );
  await waitFor(() => expect(view.queryByRole('img', { name: 'Orange robot' })).not.toBeNull());
  expect(view.queryByText('正在生成图片…')).toBeNull();
});
it('shows terminal cancellation, provider failure, and missing or invalid results instead of an empty message', async () => {
  const view = render(<App status={{ type: 'incomplete', reason: 'cancelled' }} busy={false} />);
  await waitFor(() => expect(view.queryByRole('alert')).not.toBeNull());
  expect(view.getByRole('alert').textContent).toContain('已停止等待图片');
  for (const props of [
    { isError: true, result: 'image_generation_failed' },
    { result: { invalid: true } },
    {},
  ]) {
    view.rerender(<App status={{ type: 'complete', reason: 'stop' }} busy={false} {...props} />);
    await waitFor(() => expect(view.queryByRole('alert')).not.toBeNull());
    expect(view.getByRole('alert').textContent).toContain('图片生成未完成');
  }
});

it('opens generated images in a transient zoomable dialog without requesting another generation', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const page = render(
    <App status={{ type: 'complete', reason: 'stop' }} busy={false} result={imageResult} />,
  );
  const trigger = await page.findByRole('button', { name: '查看大图：Orange robot' });
  fireEvent.click(trigger);
  let dialog = within(await page.findByRole('dialog', { name: 'Orange robot' }));
  fireEvent.load(dialog.getByRole('img', { name: 'Orange robot' }));
  fireEvent.click(dialog.getByRole('button', { name: '放大图片' }));
  expect(dialog.getByLabelText('图片缩放比例').textContent).toBe('125%');
  fireEvent.click(dialog.getByRole('button', { name: '缩小图片' }));
  expect(dialog.getByLabelText('图片缩放比例').textContent).toBe('100%');
  fireEvent.keyDown(dialog.getByRole('button', { name: '放大图片' }), { key: '+' });
  expect(dialog.getByLabelText('图片缩放比例').textContent).toBe('125%');
  fireEvent.click(dialog.getByRole('button', { name: '适应窗口' }));
  expect(dialog.getByLabelText('图片缩放比例').textContent).toBe('100%');
  fireEvent.click(dialog.getByRole('button', { name: '关闭图片预览' }));
  await waitFor(() => expect(page.queryByRole('dialog')).toBeNull());
  fireEvent.click(trigger);
  dialog = within(await page.findByRole('dialog', { name: 'Orange robot' }));
  expect(dialog.getByLabelText('图片缩放比例').textContent).toBe('100%');
  fireEvent.keyDown(dialog.getByRole('button', { name: '关闭图片预览' }), { key: 'Escape' });
  await waitFor(() => expect(page.queryByRole('dialog')).toBeNull());
  expect(fetch).not.toHaveBeenCalled();
});

it('keeps image load failure and retry inside the preview', async () => {
  const page = render(
    <App status={{ type: 'complete', reason: 'stop' }} busy={false} result={imageResult} />,
  );
  fireEvent.click(await page.findByRole('button', { name: '查看大图：Orange robot' }));
  const dialog = within(await page.findByRole('dialog', { name: 'Orange robot' }));
  fireEvent.error(dialog.getByRole('img'));
  expect(dialog.getByRole('alert').textContent).toContain('图片无法读取');
  fireEvent.click(dialog.getByRole('button', { name: '重试' }));
  fireEvent.load(dialog.getByRole('img'));
  expect(dialog.queryByRole('alert')).toBeNull();
  expect(dialog.getByRole('button', { name: '放大图片' })).toHaveProperty('disabled', false);
});
