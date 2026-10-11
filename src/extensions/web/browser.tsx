import { Globe, Search } from 'lucide-react';
import type { Toolkit, ToolCallMessagePartProps } from '@assistant-ui/react';
import { ToolActivity } from '../../browser/tool-activity';
function Read(part: ToolCallMessagePartProps) {
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
      labels={{ active: '正在读取网页', complete: '已读取网页', failed: '网页读取失败' }}
    />
  );
}
function SearchWeb(part: ToolCallMessagePartProps) {
  return (
    <ToolActivity
      part={part}
      query={String(part.args?.query ?? '')}
      icon={<Search />}
      labels={{ active: '正在搜索网页', complete: '已搜索网页', failed: '网页搜索失败' }}
    />
  );
}
export const toolkit = {
  read_web: { type: 'backend', render: Read },
  read_webpage: { type: 'backend', render: Read },
  search_web: { type: 'backend', render: SearchWeb },
} satisfies Toolkit;
