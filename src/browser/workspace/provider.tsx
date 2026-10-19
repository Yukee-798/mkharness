import { useLocale } from '../app/locale';
import { useBrowserExtensions } from '../extensions/extension-loading';
import type { LayoutAdapter } from './layout';
import configuration from '../../../scenarios.config';
import type { ScenarioDefinition } from '../../scenarios/registry';
import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from '../api';
import { workspaceError } from './error';
import { useWorkspaceCommands } from './commands';
import type { Json } from '../../shared/json';
import type {
  ScenarioInstance,
  WorkspaceSnapshot,
  WorkspaceReference,
  WorkspaceReceipt,
} from '../../shared/workspace';
import { Button } from '../ui/button';
import { Alert, AlertDescription } from '../ui/alert';
import { PanelRightClose, PanelRightOpen, X } from 'lucide-react';
import { useComposerDraft } from '../workbench/composer-drafts';

type WorkspaceContext = {
  instance?: ScenarioInstance;
  scene?: ScenarioDefinition;
  layouts: Record<string, LayoutAdapter>;
  snapshot?: WorkspaceSnapshot;
  references: WorkspaceReference[];
  select: (refs: WorkspaceReference[]) => void;
  execute: (
    name: string,
    input: Json,
    expected?: Record<string, number>,
  ) => Promise<WorkspaceReceipt>;
  read: <T>(query: string, input?: Json, cursor?: string) => Promise<T>;
  activeObjectId?: string;
  openObject: (id: string) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  busy: boolean;
  connected: boolean;
  error?: string;
  retry?: () => Promise<WorkspaceReceipt>;
};
const Context = createContext<WorkspaceContext | null>(null);
export const useWorkspace = () => useContext(Context);
function loadPreference(key: string, fallback: boolean) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === 'true';
  } catch {
    return fallback;
  }
}
export function WorkspaceProvider({
  userId,
  chatId,
  children,
}: {
  userId: string;
  chatId: string;
  children: ReactNode;
}) {
  const instance = useQuery({
    queryKey: ['user', userId, 'instance', chatId],
    queryFn: ({ signal }) =>
      request<ScenarioInstance>(`/scenarios/chat/${encodeURIComponent(chatId)}`, { signal }),
    enabled: !!userId && !!chatId,
    retry: false,
  });
  return (
    <InstanceWorkspace userId={userId} chatId={chatId} instance={instance.data}>
      {children}
    </InstanceWorkspace>
  );
}
function InstanceWorkspace({
  userId,
  chatId,
  instance,
  children,
}: {
  userId: string;
  chatId: string;
  instance?: ScenarioInstance;
  children: ReactNode;
}) {
  const { t } = useLocale();
  const extensions = useBrowserExtensions(userId);
  const layouts = Object.assign(
    {},
    ...(extensions.loaded.data?.modules ?? []).map((module) => module.layouts ?? {}),
  ) as Record<string, LayoutAdapter>;
  const client = useQueryClient(),
    scenarioId = instance?.id;
  const key = useMemo(
    () => ['user', userId, 'workspace', scenarioId] as const,
    [userId, scenarioId],
  );
  const read = useCallback(
    <T,>(query: string, input: Json = {}, cursor?: string) =>
      request<T>(`/scenarios/${encodeURIComponent(scenarioId!)}/workspace/read`, {
        method: 'POST',
        body: JSON.stringify({ query, input, ...(cursor ? { cursor } : {}) }),
      }),
    [scenarioId],
  );
  const snapshot = useQuery({
    queryKey: key,
    queryFn: () => read<WorkspaceSnapshot>('snapshot'),
    enabled: !!scenarioId,
    retry: false,
  });
  const scene: ScenarioDefinition | undefined = configuration.scenes.find(
    (scene) => scene.id === instance?.kind,
  );
  const preference = `workspace:${userId}:${scenarioId}:open`;
  const [activeObjectId, setActiveObjectId] = useState<string>();
  const [open, setOpenState] = useState(false),
    [connected, setConnected] = useState(false);
  const { executeCommand, busy, error, retry, clearError } = useWorkspaceCommands(
    userId,
    scenarioId,
  );
  const draft = useComposerDraft(chatId);
  const { workspaceReferences: references } = useSyncExternalStore(
    draft.subscribe,
    draft.getSnapshot,
    draft.getSnapshot,
  );
  useEffect(() => {
    setActiveObjectId(undefined);
  }, [draft]);
  const select = useCallback(
    (refs: WorkspaceReference[]) => {
      draft.setWorkspaceReferences(refs);
    },
    [draft],
  );
  const setOpen = useCallback(
    (value: boolean) => {
      setOpenState(value);
      try {
        localStorage.setItem(preference, String(value));
      } catch {
        /* Optional preference. */
      }
    },
    [preference],
  );
  useEffect(() => {
    setOpenState(loadPreference(preference, scene?.layout === 'studio'));
  }, [preference, scene?.layout]);
  const known = useRef(new Set<string>()),
    first = useRef(true);
  useEffect(() => {
    known.current = new Set();
    first.current = true;
  }, [scenarioId]);
  useEffect(() => {
    if (!snapshot.data) return;
    const reports = snapshot.data.objects.filter((o) =>
      scene?.activationObjectTypes?.includes(o.type),
    );
    if (!first.current && reports.some((o) => !known.current.has(o.id))) setOpen(true);
    known.current = new Set(reports.map((o) => o.id));
    first.current = false;
  }, [snapshot.data, setOpen, scene]);
  useEffect(() => {
    setConnected(false);
    if (!scenarioId) return;
    const events = new EventSource(
      `/api/scenarios/${encodeURIComponent(scenarioId)}/workspace/events`,
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    events.onopen = () => setConnected(true);
    events.onerror = () => setConnected(false);
    events.addEventListener('invalidate', (event) => {
      let watermark: number;
      try {
        watermark = Number(JSON.parse(event.data).watermark);
      } catch {
        return;
      }
      if (watermark <= (client.getQueryData<WorkspaceSnapshot>(key)?.watermark ?? -1) || timeout)
        return;
      timeout = setTimeout(() => {
        timeout = undefined;
        void client.invalidateQueries({ queryKey: key });
      }, 120);
    });
    return () => {
      events.close();
      clearTimeout(timeout);
    };
  }, [scenarioId, client, key]);
  const execute = useCallback(
    (name: string, input: Json, expected: Record<string, number> = {}) =>
      executeCommand({ requestId: crypto.randomUUID(), name, input, expected }),
    [executeCommand],
  );
  const openObject = (id: string) => {
    setActiveObjectId(id);
    setOpen(true);
  };
  const value = {
    activeObjectId,
    openObject,
    layouts,
    instance,
    scene,
    snapshot: snapshot.data,
    references,
    select,
    execute,
    read,
    open,
    setOpen,
    busy,
    connected,
    error,
    retry,
  };
  return (
    <Context value={value}>
      {(error || snapshot.error) && (
        <Alert variant="destructive" className="m-3 w-auto">
          <AlertDescription>
            {t(error || workspaceError(snapshot.error))}
            {retry && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void retry().catch(() => {})}
              >
                {t('重试同一操作')}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                clearError();
                void snapshot.refetch();
              }}
            >
              {t('刷新工作区')}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {children}
    </Context>
  );
}
export function WorkspaceToggle() {
  const { t } = useLocale();
  const workspace = useWorkspace();
  if (
    !workspace?.instance ||
    (workspace.scene?.layout !== 'studio' &&
      !workspace.snapshot?.objects.some((o) =>
        workspace.scene?.activationObjectTypes?.includes(o.type),
      ))
  )
    return null;
  const label =
    workspace.scene?.layout === 'studio'
      ? workspace.open
        ? t('收起聊天')
        : t('展开聊天')
      : workspace.open
        ? t('收起工作区')
        : t('展开工作区');
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      aria-expanded={workspace.open}
      onClick={() => workspace.setOpen(!workspace.open)}
    >
      {workspace.open ? <PanelRightClose /> : <PanelRightOpen />}
    </Button>
  );
}
export function WorkspaceReferences() {
  const { t } = useLocale();
  const w = useWorkspace();
  if (!w?.references.length) return null;
  return (
    <div className="flex flex-wrap gap-2" aria-label={t('引用的工作对象')}>
      {w.references.map((ref) => (
        <span
          key={`${ref.objectId}:${ref.anchor ?? ''}`}
          className="inline-flex max-w-full items-center gap-1 rounded-md border bg-muted/40 px-2 py-1 text-xs"
        >
          <span className="truncate">
            {w.snapshot?.objects.find((o) => o.id === ref.objectId)?.title ?? t('工作对象')}
            {ref.text ? ` · ${ref.text.slice(0, 50)}` : ''}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-5"
            aria-label={t('移除引用')}
            onClick={() => w.select(w.references.filter((r) => r !== ref))}
          >
            <X className="size-3" />
          </Button>
        </span>
      ))}
    </div>
  );
}
