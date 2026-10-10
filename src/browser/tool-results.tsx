import type { ComponentType } from 'react';
import type { ToolCallMessagePartProps } from '@assistant-ui/react';

// Static, application-reviewed React components. Unknown tools retain bounded assistant-ui details.
export const toolResults: Record<string, ComponentType<ToolCallMessagePartProps>> = {};
