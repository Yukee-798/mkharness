import { useLocale } from '../app/locale';
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '../ui/resizable';
import type { GroupImperativeHandle } from 'react-resizable-panels';
import type { LayoutId } from '../../scenarios/registry';
import { useWorkspace } from './provider';
import { browserScenes } from '../../scenarios/browser';
export type LayoutAdapter = { conversationSide: 'left' | 'right'; primaryShare: number };
export const layoutAdapters: Record<LayoutId, LayoutAdapter> = {
  chat: { conversationSide: 'left', primaryShare: 0 },
  split: { conversationSide: 'left', primaryShare: 48 },
  studio: { conversationSide: 'right', primaryShare: 66 },
};
/** Persistent conversation slot: toggling visibility never remounts its runtime. */
export function LayoutHost({
  layout,
  expanded,
  conversation,
  primary,
  inspector,
  preferenceKey,
  adapter: customAdapter,
}: {
  layout: LayoutId;
  expanded: boolean;
  conversation: ReactNode;
  primary?: ReactNode;
  inspector?: ReactNode;
  preferenceKey?: string;
  adapter?: LayoutAdapter;
}) {
  const adapter = customAdapter ?? layoutAdapters[layout] ?? layoutAdapters.split,
    root = useRef<HTMLDivElement>(null),
    group = useRef<GroupImperativeHandle>(null);
  const [wide, setWide] = useState(false);
  const [share, setShare] = useState(adapter.primaryShare);
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(`${preferenceKey}:width`));
      setShare(saved >= 20 && saved <= 80 ? saved : adapter.primaryShare);
    } catch {
      setShare(adapter.primaryShare);
    }
  }, [preferenceKey, adapter.primaryShare]);
  useEffect(() => {
    if (!root.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setWide(entry.contentRect.width >= 800);
    });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  const studio = adapter.conversationSide === 'right',
    hasPrimary = layout !== 'chat' && !!primary;
  const conversationVisible = !hasPrimary || (studio ? expanded : !expanded || wide);
  const primaryVisible = hasPrimary && (studio ? wide || !expanded : expanded);
  const ratio = primaryVisible ? (conversationVisible ? share : 100) : 0;
  const resize = () => {
    const handle = group.current,
      current = handle?.getLayout();
    if (!handle || !current || current['scene-primary'] === undefined) return;
    if (Math.abs(current['scene-primary'] - ratio) > 0.1)
      handle.setLayout({ 'scene-chat': 100 - ratio, 'scene-primary': ratio });
  };
  useEffect(resize, [ratio]);
  const conversationPane = (
    <ResizablePanel
      id="scene-chat"
      key="conversation"
      defaultSize={`${100 - adapter.primaryShare}%`}
      minSize={conversationVisible && primaryVisible && wide ? '320px' : 0}
      maxSize={conversationVisible ? '100%' : 0}
    >
      <div className={`h-full min-h-0 flex-col ${conversationVisible ? 'flex' : 'hidden'}`}>
        {conversation}
      </div>
    </ResizablePanel>
  );
  const primaryPane = hasPrimary ? (
    <ResizablePanel
      id="scene-primary"
      key="primary"
      defaultSize={`${adapter.primaryShare}%`}
      minSize={primaryVisible && conversationVisible && wide ? '320px' : 0}
      maxSize={primaryVisible ? '100%' : 0}
    >
      <div
        className={`h-full min-h-0 flex-col overflow-hidden ${primaryVisible ? 'flex' : 'hidden'}`}
      >
        {primary}
        {inspector}
      </div>
    </ResizablePanel>
  ) : null;
  const separator =
    primaryVisible && conversationVisible && wide ? <ResizableHandle key="separator" /> : null;
  return (
    <div
      ref={root}
      className="flex min-h-0 min-w-0 flex-1"
      data-slot="scenario-layout"
      data-layout={layout}
    >
      <ResizablePanelGroup
        orientation="horizontal"
        groupRef={group}
        onLayoutChanged={(_value, { isUserInteraction }) => {
          if (!isUserInteraction) resize();
          else if (primaryVisible && conversationVisible && wide) {
            const value = _value['scene-primary'];
            if (value >= 20 && value <= 80) {
              setShare(value);
              try {
                localStorage.setItem(`${preferenceKey}:width`, String(value));
              } catch {
                /* Optional preference. */
              }
            }
          }
        }}
      >
        {studio
          ? [primaryPane, separator, conversationPane]
          : [conversationPane, separator, primaryPane]}
      </ResizablePanelGroup>
    </div>
  );
}
const views = Object.fromEntries(
  Object.entries(browserScenes).map(([id, load]) => [id, lazy(load)]),
);
export function ScenarioLayout({ children }: { children: ReactNode }) {
  const { t } = useLocale();
  const workspace = useWorkspace(),
    kind = workspace?.instance?.kind;
  const Content = kind ? views[kind] : undefined;
  // Agent uses the split adapter only when reports exist; plain chat stays full width.
  const defaultLayout = workspace?.scene?.layout ?? 'chat';
  const layout =
    defaultLayout === 'chat' &&
    workspace?.snapshot?.objects.some((o) =>
      workspace.scene?.activationObjectTypes?.includes(o.type),
    )
      ? 'split'
      : defaultLayout;
  return (
    <LayoutHost
      layout={layout}
      adapter={workspace?.layouts[layout]}
      preferenceKey={`layout:${workspace?.instance?.id}`}
      expanded={workspace?.open ?? false}
      conversation={children}
      primary={
        Content ? (
          <Suspense
            fallback={<p className="p-4 text-sm text-muted-foreground">{t('正在读取工作区…')}</p>}
          >
            <Content key={workspace?.instance?.id} />
          </Suspense>
        ) : undefined
      }
    />
  );
}
