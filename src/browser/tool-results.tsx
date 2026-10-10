import type { ComponentType } from 'react';
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
// Static, application-reviewed React components. Tool details stay available separately.
export const toolResults: Record<string, ComponentType<ToolCallMessagePartProps>> = {
  describe_text: DescribeTextResult,
};
