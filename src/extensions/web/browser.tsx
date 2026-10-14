import { useLocale } from '../../browser/locale';
import { Globe, Search } from 'lucide-react';
import { useAuiState, type Toolkit, type ToolCallMessagePartProps } from '@assistant-ui/react';
import { useState } from 'react';
import { canonicalMessageId, useExtensionContext } from '../../browser/extension-context';
import { Sources } from '../../browser/sources';
import type { SourcesState } from './sources';
import { ToolActivity } from '../../browser/tool-activity';
function Read(part: ToolCallMessagePartProps) {
  const { t } = useLocale();
  let query: string;
  try {
    query = new URL(String(part.args?.url)).hostname;
  } catch {
    query = '';
  }
  return (
    <ToolActivity
      part={part}
      query={query}
      icon={<Globe />}
      labels={{ active: t('正在读取网页'), complete: t('已读取网页'), failed: t('网页读取失败') }}
    />
  );
}
function SearchWeb(part: ToolCallMessagePartProps) {
  const { t } = useLocale();
  return (
    <ToolActivity
      part={part}
      query={String(part.args?.query ?? '')}
      icon={<Search />}
      labels={{ active: t('正在搜索网页'), complete: t('已搜索网页'), failed: t('网页搜索失败') }}
    />
  );
}
export const toolkit = {
  read_web: { type: 'backend', render: Read },
  read_webpage: { type: 'backend', render: Read },
  search_web: { type: 'backend', render: SearchWeb },
} satisfies Toolkit;

function WebSources() {
  const { state, messageIds } = useExtensionContext();
  const messageId = useAuiState((s) => s.message.id);
  const { locale } = useLocale();
  const [open, setOpen] = useState(false);
  const sources = (state?.web as SourcesState | undefined)?.replies?.[
    canonicalMessageId(messageId, messageIds)
  ];
  if (!sources?.length) return null;
  return (
    <Sources
      sources={sources}
      open={open}
      onOpenChange={setOpen}
      locale={locale}
      className="mt-2"
    />
  );
}
export const ui = { assistantFooter: WebSources };
