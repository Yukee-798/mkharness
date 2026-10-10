// Source: https://r.assistant-ui.com/elements-collapsible-root.json
// Copyright (c) 2026 AgentbaseAI Inc. (MIT); see THIRD_PARTY_NOTICES.md.
'use client';

import { Collapsible as CollapsiblePrimitive } from 'radix-ui';
import { forwardRef } from 'react';

export const Collapsible = forwardRef<
  React.ComponentRef<typeof CollapsiblePrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Root>
>(function CollapsibleRoot(props, ref) {
  return <CollapsiblePrimitive.Root ref={ref} data-slot="collapsible" {...props} />;
});

export function CollapsibleTrigger({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  return <CollapsiblePrimitive.CollapsibleTrigger data-slot="collapsible-trigger" {...props} />;
}

export function CollapsibleContent({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  return <CollapsiblePrimitive.CollapsibleContent data-slot="collapsible-content" {...props} />;
}
