import { useLocale } from '../../browser/app/locale';
import type { Toolkit } from '@assistant-ui/react';
import { ToolActivity } from '../../browser/chat/messages/tool-activity';
import type { ToolCallMessagePartProps } from '@assistant-ui/react';

function DescribeTextResult(part: ToolCallMessagePartProps) {
  const { t } = useLocale();
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
    <p className="rounded-lg border px-3 py-2 text-sm">
      {t('文字包含 {count} 个字符。', { count: value.characters })}
    </p>
  );
}
function DescribeText(part: ToolCallMessagePartProps) {
  const { t } = useLocale();
  return (
    <>
      <ToolActivity
        part={part}
        labels={{ active: t('正在统计文字'), complete: t('已统计文字'), failed: t('文字统计失败') }}
      />
      <DescribeTextResult {...part} />
    </>
  );
}
export const toolkit = {
  describe_text: { type: 'backend', render: DescribeText },
} satisfies Toolkit;
