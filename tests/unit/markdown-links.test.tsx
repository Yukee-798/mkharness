// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import {
  AssistantRuntimeProvider,
  MessageByIndexProvider,
  MessagePrimitive,
  useExternalStoreRuntime,
} from '@assistant-ui/react';
import { MarkdownText } from '../../src/browser/chat/messages/markdown-text';
afterEach(cleanup);
function Message({ text }: { text: string }) {
  const runtime = useExternalStoreRuntime({
    messages: [
      { id: 'message', role: 'assistant' as const, content: [{ type: 'text' as const, text }] },
    ],
    convertMessage: (message) => message,
    onNew: async () => {},
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <MessageByIndexProvider index={0}>
        <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
      </MessageByIndexProvider>
    </AssistantRuntimeProvider>
  );
}
it('ends a bare URL before the Chinese explanatory sentence', async () => {
  const text =
    '来源：https://time.is/Beijing（页面抓取结果，非我本地时钟）。如果你在别的时区，且当地已过午夜，那边可能已经是周一了；告诉我哪个城市，我可以帮你换算。';
  const view = render(<Message text={text} />);
  await waitFor(() => expect(view.container.querySelector('a')).not.toBeNull());
  const link = view.container.querySelector('a')!;
  expect(link.getAttribute('href')).toBe('https://time.is/Beijing');
  expect(link.textContent).toBe('https://time.is/Beijing');
  expect(view.container.textContent).toBe(text);
});

it.each([
  ['https://example.com/path，说明。', ['https://example.com/path']],
  ['https://example.com/中文路径（补充说明）', ['https://example.com/中文路径']],
  [
    'https://example.com?q=%E4%B8%AD%E6%96%87&next=1；说明',
    ['https://example.com?q=%E4%B8%AD%E6%96%87&next=1'],
  ],
  [
    'https://one.example/report，https://two.example/report（另一份）',
    ['https://one.example/report', 'https://two.example/report'],
  ],
  ['www.example.com（说明）', ['http://www.example.com']],
])('bounds literal links in %s', async (text, urls) => {
  const view = render(<Message text={text} />);
  await waitFor(() => expect(view.container.querySelectorAll('a')).toHaveLength(urls.length));
  expect(
    [...view.container.querySelectorAll('a')].map((a) => new URL(a.getAttribute('href')!).href),
  ).toEqual(urls.map((url) => new URL(url).href));
  expect(view.container.textContent).toBe(text);
});

it.each([
  [
    '[中文，完整标签](https://example.com/页面（版本）)',
    '中文，完整标签',
    'https://example.com/页面（版本）',
  ],
  [
    '[https://example.com/页面（版本）](https://example.com/页面（版本）)',
    'https://example.com/页面（版本）',
    'https://example.com/页面（版本）',
  ],
  [
    '<https://example.com/页面（版本）>',
    'https://example.com/页面（版本）',
    'https://example.com/页面（版本）',
  ],
  [
    '[来源][ref]\n\n[ref]: https://example.com/页面（版本）',
    '来源',
    'https://example.com/页面（版本）',
  ],
])('preserves authored links in %s', async (text, label, url) => {
  const view = render(<Message text={text} />);
  await waitFor(() => expect(view.container.querySelector('a')).not.toBeNull());
  const link = view.container.querySelector('a')!;
  expect(link.textContent).toBe(label);
  expect(decodeURI(link.getAttribute('href')!)).toBe(url);
});

it('does not turn URLs inside inline code into links', async () => {
  const view = render(<Message text={'`https://example.com（说明）`'} />);
  await waitFor(() => expect(view.container.querySelector('code')).not.toBeNull());
  expect(view.container.querySelector('a')).toBeNull();
});

it('preserves fenced code containing URL punctuation', async () => {
  const view = render(<Message text={'```text\nhttps://example.com（说明）\n```'} />);
  await waitFor(() => expect(view.container.querySelector('pre code')).not.toBeNull());
  expect(view.container.querySelector('a')).toBeNull();
  expect(view.container.querySelector('pre code')?.textContent).toContain(
    'https://example.com（说明）',
  );
});
