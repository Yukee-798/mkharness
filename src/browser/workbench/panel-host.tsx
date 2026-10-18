import {
  Component,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { Maximize2, Minimize2, PanelRightOpen, X } from 'lucide-react';
import { useBrowserExtensions } from '../extensions/extension-loading';
import { useIsomorphicLayoutEffect } from '../hooks/use-isomorphic-layout-effect';
import { useLocale } from '../app/locale';
import { Button } from '../ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '../ui/sheet';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '../ui/resizable';
import { WorkbenchPanels } from './panel-state';
import type { ConversationPort, WorkbenchPanelDefinition } from './panels';

const Context = createContext<WorkbenchPanels | null>(null);
export const useWorkbench = () => useContext(Context);
export function WorkbenchProvider({
  userId,
  chatId,
  visible = true,
  children,
}: {
  userId: string;
  chatId: string;
  visible?: boolean;
  children: ReactNode;
}) {
  const controller = useMemo(() => {
    let storage: Storage | undefined;
    try {
      if (userId) storage = localStorage;
    } catch {
      /* In-memory layout remains usable. */
    }
    return new WorkbenchPanels(userId, storage);
  }, [userId]);
  const { loaded } = useBrowserExtensions(userId);
  const definitions = useMemo(
    () =>
      new Map(
        (loaded.data?.modules ?? []).flatMap((module) =>
          Object.entries(module.panels ?? {}).map(
            ([name, definition]) => [`${module.id}/${name}`, definition] as const,
          ),
        ),
      ),
    [loaded.data],
  );
  useIsomorphicLayoutEffect(() => {
    controller.setDefinitions(definitions);
    controller.selectChat(chatId);
    controller.setPageVisible(visible);
  }, [controller, definitions, chatId, visible]);
  return <Context value={controller}>{children}</Context>;
}
class PanelError extends Component<
  { children: ReactNode; retry: () => void; label: string; retryLabel: string },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div role="alert" className="p-6">
        <p>{this.props.label}</p>
        <Button
          variant="outline"
          className="mt-3"
          aria-label={this.props.retryLabel}
          onClick={this.props.retry}
        >
          {this.props.retryLabel}
        </Button>
      </div>
    ) : (
      this.props.children
    );
  }
}
export function WorkbenchPanelLayout({
  children,
  conversation,
}: {
  children: ReactNode;
  conversation: ConversationPort;
}) {
  const controller = useWorkbench();
  if (!controller) return children;
  return (
    <PanelLayout controller={controller} conversation={conversation}>
      {children}
    </PanelLayout>
  );
}
function PanelLayout({
  controller,
  children,
  conversation,
}: {
  controller: WorkbenchPanels;
  children: ReactNode;
  conversation: ConversationPort;
}) {
  const { t } = useLocale();
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const root = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!root.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry!.contentRect.width > 0) setWide(entry!.contentRect.width >= 760);
    });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  const active =
    state.active && (state.active.chatId === null || state.active.chatId === conversation.chatId)
      ? state.active
      : null;
  const definition: WorkbenchPanelDefinition | undefined = active
    ? controller.definition(active.type)
    : undefined;
  const visible = !!active && !state.hidden && state.pageVisible;
  const Content = definition?.Content;
  let title = t('工作面板');
  try {
    if (active && definition) title = t(definition.title(active.target));
  } catch {
    /* Use the generic title. */
  }
  const header = (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
      <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h2>
      {wide && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={state.maximized ? t('恢复面板大小') : t('最大化面板')}
          onClick={controller.toggleMaximized}
        >
          {state.maximized ? <Minimize2 /> : <Maximize2 />}
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t('收起工作面板')}
        onClick={controller.hidePanel}
      >
        <X />
      </Button>
    </div>
  );
  const content = active && (
    <PanelError
      key={`${active.chatId}:${active.type}:${active.key}:${retry}`}
      label={t('工作面板暂时无法显示')}
      retryLabel={t('重试')}
      retry={() => setRetry((value) => value + 1)}
    >
      {Content ? (
        <Content target={active.target} visible={visible} conversation={conversation} />
      ) : (
        <p role="alert" className="p-6 text-sm text-muted-foreground">
          {t('此工作面板当前不可用')}
        </p>
      )}
    </PanelError>
  );
  const pane = (
    <section
      aria-label={t('工作面板')}
      className="flex h-full min-h-0 flex-col overflow-hidden bg-background"
    >
      {header}
      <div className="min-h-0 flex-1 overflow-auto p-4">{content}</div>
    </section>
  );
  return (
    <div ref={root} className="flex min-h-0 min-w-0 flex-1 flex-col">
      {(state.latest || (active && state.hidden)) && (
        <div className="flex shrink-0 justify-end border-b px-4 py-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (state.latest) controller.openPanel({ ...state.latest, activation: 'explicit' });
              else controller.showPanel();
            }}
          >
            <PanelRightOpen />
            {state.latest ? t('查看新内容') : t('打开工作面板')}
          </Button>
        </div>
      )}
      <ResizablePanelGroup
        orientation="horizontal"
        onLayoutChanged={(layout) => {
          if (visible && wide && !state.maximized)
            controller.setWidth(layout.workbench ?? state.width);
        }}
      >
        <ResizablePanel
          id="conversation"
          minSize={visible && wide && !state.maximized ? '360px' : 0}
          defaultSize="55%"
          style={{ display: wide && visible && state.maximized ? 'none' : undefined }}
        >
          <div className="flex h-full min-h-0 flex-col">{children}</div>
        </ResizablePanel>
        {wide && visible && !state.maximized && <ResizableHandle />}
        {wide && active && (
          <ResizablePanel
            id="workbench"
            minSize={visible && !state.maximized ? '360px' : 0}
            defaultSize={`${state.width}%`}
            style={{ display: visible ? undefined : 'none' }}
          >
            {pane}
          </ResizablePanel>
        )}
      </ResizablePanelGroup>
      {!wide && (
        <Sheet
          open={visible}
          onOpenChange={(open) => {
            if (!open) controller.hidePanel();
          }}
        >
          <SheetContent
            side="right"
            className="h-dvh w-full max-w-none gap-0 p-0 sm:max-w-none"
            showCloseButton={false}
          >
            <SheetHeader className="sr-only">
              <SheetTitle>{title}</SheetTitle>
              <SheetDescription>{t('查看和操作当前工作内容')}</SheetDescription>
            </SheetHeader>
            {pane}
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
