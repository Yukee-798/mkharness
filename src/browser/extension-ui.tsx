import { Component, useContext, type ReactNode } from 'react';
import type { ToolCallMessagePartProps } from '@assistant-ui/react';
import { ExtensionContext } from './extension-context';

class DecorationBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}
export function ToolTitleMeta({ part }: { part: ToolCallMessagePartProps }) {
  const context = useContext(ExtensionContext);
  return context?.ui?.map(({ id, toolTitleMeta: Meta }) =>
    Meta ? (
      <DecorationBoundary key={id}>
        <Meta part={part} />
      </DecorationBoundary>
    ) : null,
  );
}
export function AssistantFooterExtensions() {
  const context = useContext(ExtensionContext);
  return context?.ui?.map(({ id, assistantFooter: Footer }) =>
    Footer ? (
      <DecorationBoundary key={id}>
        <Footer />
      </DecorationBoundary>
    ) : null,
  );
}
