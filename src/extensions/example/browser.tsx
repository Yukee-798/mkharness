import type { Toolkit } from '@assistant-ui/react';
import { ToolActivity } from '../../browser/tool-activity';
import type { ToolCallMessagePartProps } from '@assistant-ui/react';

function DescribeTextResult(part: ToolCallMessagePartProps) {
  if (part.isError || part.status.type !== 'complete') return null;
  let value: unknown = part.result;
  try {
    if (typeof value === 'string') value = JSON.parse(value);
  } catch {
    return null;
  }
  if (
    !value ||
    typeof value !== 'object' ||
    !('characters' in value) ||
    typeof value.characters !== 'number'
  )
    return null;
  return (
    <p className="rounded-lg border px-3 py-2 text-sm">文字包含 {value.characters} 个字符。</p>
  );
}
function DescribeText(part: ToolCallMessagePartProps) {
  return (
    <>
      <ToolActivity
        part={part}
        labels={{ active: '正在统计文字', complete: '已统计文字', failed: '文字统计失败' }}
      />
      <DescribeTextResult {...part} />
    </>
  );
}
export const toolkit = {
  describe_text: { type: 'backend', render: DescribeText },
} satisfies Toolkit;
