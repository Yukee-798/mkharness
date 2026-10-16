// Composition adapted from https://r.assistant-ui.com/mcp-config.json.
// Copyright (c) 2026 AgentbaseAI Inc. (MIT); see THIRD_PARTY_NOTICES.md.
import { createContext, useContext, useId, useRef, useState } from 'react';
import { AuiConfig, AuiProvider, useAui, useAuiState } from '@assistant-ui/store';
import {
  McpManagerPrimitive,
  McpServerPrimitive,
  McpAddFormPrimitive,
} from '@assistant-ui/react-mcp';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { request } from '../../browser/api';
import { useLocale } from '../../browser/app/locale';
import { Button } from '../../browser/ui/button';
import { Input } from '../../browser/ui/input';
import { NativeSelect, NativeSelectOption } from '../../browser/ui/native-select';
import { Badge } from '../../browser/ui/badge';
import { Checkbox } from '../../browser/ui/checkbox';
import { Label } from '../../browser/ui/label';
import { Alert, AlertDescription } from '../../browser/ui/alert';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../browser/ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '../../browser/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../browser/ui/alert-dialog';
import type { ConnectionView, ToolPermission } from '../../shared/mcp-connections';
import { ServerMcpManager, type McpManagementActions } from './manager';

const permissions = {
  disabled: 'Disabled',
  ask: 'Ask every time',
  auto: 'Allow automatically',
} as const;
const statuses = {
  disconnected: 'Disconnected',
  connecting: 'Connecting',
  authorizing: 'Authorization required',
  ready: 'Ready',
  reauthorize: 'Reconnect required',
  error: 'Connection failed',
} as const;
type OAuthClientFields = {
  clientId: string;
  clientSecret: string;
  onClientId: (v: string) => void;
  onClientSecret: (v: string) => void;
};
const OAuthClientContext = createContext<OAuthClientFields | null>(null);
export function McpConnections({ userId }: { userId: string }) {
  const { t } = useLocale(),
    client = useQueryClient();
  const queryKey = ['user', userId, 'mcp-connections'];
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      request<{ connections: ConnectionView[] }>('/mcp/connections', { signal }),
    retry: false,
  });
  const views = query.data?.connections ?? [];
  const [adding, setAdding] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [remove, setRemove] = useState<ConnectionView>();
  const [clientId, setClientId] = useState(''),
    [clientSecret, setClientSecret] = useState('');
  const inFlight = useRef(false);
  async function perform<T>(work: () => Promise<T>): Promise<T> {
    if (inFlight.current) throw new Error(t('A connection change is already in progress.'));
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      return await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection failed');
      throw e;
    } finally {
      try {
        await client.invalidateQueries({ queryKey });
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  const patch = (view: ConnectionView, value: object) =>
    request(`/mcp/connections/${view.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ revision: view.revision, ...value }),
    });
  async function connect(id: string) {
    const view = views.find((v) => v.id === id);
    if (view && !view.enabled) await patch(view, { enabled: true });
    const result = await request<{ connection: ConnectionView; authorizationUrl?: string }>(
      `/mcp/connections/${id}/connect`,
      { method: 'POST' },
    );
    if (result.authorizationUrl) window.location.assign(result.authorizationUrl);
    if (result.connection.error) throw new Error(result.connection.error);
  }
  const actions: McpManagementActions = {
    // Official button primitives do not await/catch connect/disconnect. Errors stay in this UI.
    connect: (id) => perform(() => connect(id)).catch(() => {}),
    disable: (id) =>
      perform(async () => {
        const view = views.find((v) => v.id === id);
        if (view) await patch(view, { enabled: false });
      }).catch(() => {}),
    remove: (id) =>
      perform(async () => {
        await request(`/mcp/connections/${id}`, { method: 'DELETE' });
      }),
    add: (input) =>
      perform(async () => {
        const auth = input.auth;
        if (auth.type === 'oauth' && auth.scopes?.length)
          throw new Error('OAuth scopes are discovered by the server.');
        const result = await request<{ connection: ConnectionView }>('/mcp/connections', {
          method: 'POST',
          body: JSON.stringify({
            name: input.name,
            endpoint: input.url,
            auth: auth.type === 'oauth' ? 'auto' : auth.type,
            ...(auth.type === 'bearer' ? { token: auth.token } : {}),
            ...(auth.type === 'oauth' && clientId
              ? { clientId, ...(clientSecret ? { clientSecret } : {}) }
              : {}),
          }),
        });
        setClientId('');
        setClientSecret('');
        return result.connection.id;
      }),
  };
  const config = AuiConfig({
    mcp: ServerMcpManager({ views, actions, hydrated: query.isSuccess }),
  });
  function closeForm() {
    setAdding(false);
    setClientId('');
    setClientSecret('');
  }
  return (
    <AuiProvider key={userId} config={config}>
      <McpManagerPrimitive.Root className="space-y-5 py-2" aria-label={t('MCP connections')}>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <h2 className="font-medium">{t('MCP connections')}</h2>
            <p className="text-sm text-muted-foreground">
              {t(
                'Connect remote tools to your account. Enabled tools are available in new chats; existing chats keep their tool versions.',
              )}
            </p>
          </div>
          <McpManagerPrimitive.AddCustomTrigger
            asChild
            onClick={() => {
              if (adding) closeForm();
              else setAdding(true);
            }}
          >
            <Button variant="outline" size="sm" disabled={busy}>
              <Plus />
              {t('Add connection')}
            </Button>
          </McpManagerPrimitive.AddCustomTrigger>
        </div>
        {new URLSearchParams(window.location.search).get('mcp') === 'error' && (
          <Alert variant="destructive">
            <AlertDescription>
              {t('Authorization did not complete. Connect again to retry.')}
            </AlertDescription>
          </Alert>
        )}
        {(error || query.error) && (
          <Alert variant="destructive">
            <AlertDescription>{t(error || query.error?.message || '')}</AlertDescription>
          </Alert>
        )}
        {query.isPending && (
          <p role="status" className="text-sm text-muted-foreground">
            {t('Loading connections…')}
          </p>
        )}
        {adding && (
          <AddConnection
            busy={busy}
            onClose={closeForm}
            onConnect={(id) => void actions.connect(id)}
            clientId={clientId}
            clientSecret={clientSecret}
            onClientId={setClientId}
            onClientSecret={setClientSecret}
          />
        )}
        {query.isSuccess && !views.length && !adding && (
          <p className="text-sm text-muted-foreground">{t('No connections yet.')}</p>
        )}
        <McpManagerPrimitive.CustomServers>
          {({ server }) => {
            const view = views.find((v) => v.id === server.id);
            return view ? (
              <ConnectionCard
                connection={view}
                busy={busy}
                onPatch={(value) => void perform(() => patch(view, value)).catch(() => {})}
                onRemove={() => setRemove(view)}
              />
            ) : null;
          }}
        </McpManagerPrimitive.CustomServers>
        <AlertDialog
          open={!!remove}
          onOpenChange={(open) => {
            if (!open) setRemove(undefined);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t('Disconnect')} {remove?.name}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t(
                  'Future tool calls will be blocked. Chat history and records of uncertain remote operations will remain.',
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('Cancel')}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  const id = remove?.id;
                  setRemove(undefined);
                  if (id) void actions.remove(id).catch(() => {});
                }}
              >
                {t('Disconnect')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </McpManagerPrimitive.Root>
    </AuiProvider>
  );
}
function AddConnection({
  busy,
  onClose,
  onConnect,
  clientId,
  clientSecret,
  onClientId,
  onClientSecret,
}: OAuthClientFields & {
  busy: boolean;
  onClose: () => void;
  onConnect: (id: string) => void;
}) {
  const { t } = useLocale(),
    id = useId();
  return (
    <McpAddFormPrimitive.Root
      autoComplete="off"
      onSubmitted={(serverId) => {
        onClose();
        onConnect(serverId);
      }}
      onCancel={onClose}
      className="space-y-4 rounded-xl border p-4"
    >
      <div className="space-y-2">
        <Label htmlFor={id + '-name'}>{t('Connection name')}</Label>
        <McpAddFormPrimitive.NameField asChild id={id + '-name'}>
          <Input required maxLength={80} placeholder="Notion" autoComplete="off" />
        </McpAddFormPrimitive.NameField>
      </div>
      <div className="space-y-2">
        <Label htmlFor={id + '-url'}>{t('Server URL')}</Label>
        <McpAddFormPrimitive.UrlField asChild id={id + '-url'}>
          <Input
            required
            type="url"
            autoComplete="off"
            maxLength={2048}
            placeholder="https://mcp.notion.com/mcp"
          />
        </McpAddFormPrimitive.UrlField>
      </div>
      <div className="space-y-2">
        <Label htmlFor={id + '-auth'}>{t('Authentication')}</Label>
        <McpAddFormPrimitive.AuthSelect asChild id={id + '-auth'}>
          <NativeSelect>
            <NativeSelectOption value="oauth">{t('Automatic OAuth')}</NativeSelectOption>
            <NativeSelectOption value="none">{t('No authentication')}</NativeSelectOption>
            <NativeSelectOption value="bearer">{t('Bearer token')}</NativeSelectOption>
          </NativeSelect>
        </McpAddFormPrimitive.AuthSelect>
      </div>
      <OAuthClientContext value={{ clientId, clientSecret, onClientId, onClientSecret }}>
        <McpAddFormPrimitive.AuthFields>{ConnectionAuthFields}</McpAddFormPrimitive.AuthFields>
      </OAuthClientContext>
      <p className="text-xs text-muted-foreground">
        {t(
          'Tools can send their arguments to this server. Connect only servers you trust. Credentials are encrypted on this deployment.',
        )}
      </p>
      <McpAddFormPrimitive.Error className="text-sm text-destructive" />
      <div className="flex gap-2">
        <McpAddFormPrimitive.Submit asChild disabled={busy}>
          <Button type="submit">{t('Connect')}</Button>
        </McpAddFormPrimitive.Submit>
        <McpAddFormPrimitive.Cancel asChild>
          <Button type="button" variant="ghost">
            {t('Cancel')}
          </Button>
        </McpAddFormPrimitive.Cancel>
      </div>
    </McpAddFormPrimitive.Root>
  );
}
// AuthFields treats its child as a component type. Keep its identity stable across form updates.
function ConnectionAuthFields({ authType }: { authType: string }) {
  const { t } = useLocale();
  const id = useId();
  const [advanced, setAdvanced] = useState(false);
  const client = useContext(OAuthClientContext);
  if (!client) throw new Error('Connection auth fields require their client context');
  if (authType === 'bearer')
    return (
      <div className="space-y-2">
        <Label htmlFor={id + '-token'}>{t('Bearer token')}</Label>
        <McpAddFormPrimitive.BearerTokenField asChild id={id + '-token'}>
          <Input required autoComplete="new-password" maxLength={8192} />
        </McpAddFormPrimitive.BearerTokenField>
      </div>
    );
  if (authType !== 'oauth') return null;
  return (
    <Collapsible open={advanced} onOpenChange={setAdvanced}>
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="group -ml-2 text-xs">
          {t('Advanced OAuth settings')}
          <ChevronDown className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 pt-3">
        <p className="text-xs text-muted-foreground">
          {t('Only needed when the server requires a pre-registered OAuth client.')}
        </p>
        <Input
          aria-label="Client ID"
          placeholder="Client ID"
          autoComplete="off"
          value={client.clientId}
          required={!!client.clientSecret}
          maxLength={2048}
          onChange={(e) => client.onClientId(e.target.value)}
        />
        <Input
          aria-label="Client secret"
          placeholder="Client secret (optional)"
          type="password"
          autoComplete="new-password"
          maxLength={8192}
          value={client.clientSecret}
          onChange={(e) => client.onClientSecret(e.target.value)}
        />
      </CollapsibleContent>
    </Collapsible>
  );
}
function ConnectionCard({
  connection,
  busy,
  onPatch,
  onRemove,
}: {
  connection: ConnectionView;
  busy: boolean;
  onPatch: (value: object) => void;
  onRemove: () => void;
}) {
  const { t } = useLocale(),
    aui = useAui();
  const state = useAuiState((s) => s.mcpServer.connectionState);
  return (
    <McpServerPrimitive.Root className="space-y-3 rounded-xl border p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-medium">
            <McpServerPrimitive.Name />
          </h3>
          <p className="truncate text-xs text-muted-foreground">{connection.endpoint}</p>
        </div>
        <Badge variant="secondary">{t(statuses[connection.status])}</Badge>
      </div>
      <McpServerPrimitive.Error className="text-xs text-destructive" />
      <div className="flex flex-wrap items-center gap-3">
        <Label className="font-normal">
          <Checkbox
            checked={connection.enabled}
            disabled={busy}
            onCheckedChange={(enabled) => onPatch({ enabled: enabled === true })}
          />
          {t('Enabled')}
        </Label>
        <McpServerPrimitive.ConnectButton asChild disabled={busy}>
          <Button variant="outline" size="sm">
            <RefreshCw />
            {t('Connect')}
          </Button>
        </McpServerPrimitive.ConnectButton>
        {state === 'connected' && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void aui.mcpServer().connect()}
          >
            <RefreshCw />
            {t('Refresh tools')}
          </Button>
        )}
        <McpServerPrimitive.RemoveButton
          asChild
          disabled={busy}
          onClick={(e) => {
            e.preventDefault();
            onRemove();
          }}
        >
          <Button variant="ghost" size="sm" aria-label={`${t('Disconnect')} ${connection.name}`}>
            <Trash2 />
          </Button>
        </McpServerPrimitive.RemoveButton>
      </div>
      <div className="max-h-64 space-y-2 overflow-y-auto">
        {connection.tools.map((tool) => (
          <div key={tool.name} className="flex items-center justify-between gap-3 border-t pt-2">
            <div className="min-w-0">
              <p className="break-all text-xs font-medium">{tool.name}</p>
              <p className="line-clamp-2 text-xs text-muted-foreground">{tool.description}</p>
            </div>
            {tool.supported ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    className="shrink-0 text-xs"
                    aria-label={`${tool.name}: ${t(permissions[tool.permission])}`}
                  >
                    {t(permissions[tool.permission])}
                    <ChevronDown className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuRadioGroup
                    value={tool.permission}
                    onValueChange={(value) =>
                      onPatch({ permissions: { [tool.name]: value as ToolPermission } })
                    }
                  >
                    {(Object.keys(permissions) as ToolPermission[]).map((value) => (
                      <DropdownMenuRadioItem key={value} value={value}>
                        {t(permissions[value])}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <span className="text-xs text-muted-foreground">{t('Unsupported schema')}</span>
            )}
          </div>
        ))}
      </div>
    </McpServerPrimitive.Root>
  );
}
