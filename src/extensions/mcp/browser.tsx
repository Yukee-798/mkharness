import { useRef, useState } from 'react';
import type { ToolCallMessagePartProps } from '@assistant-ui/react';
import { Plug } from 'lucide-react';
import {
  canonicalMessageId,
  useExtensionContext,
} from '../../browser/extensions/extension-context';
import { useLocale } from '../../browser/app/locale';
import { ApprovalCard, type ApprovalState } from '../../browser/chat/messages/approval-card';
import { request } from '../../browser/api';
import { Alert, AlertDescription } from '../../browser/ui/alert';
import type { ExtensionUI } from '../../browser/extensions/extensions';
import type { McpRequest } from '../../server/mcp/connections/requests';

type ProjectedRequest = McpRequest & { toolCallId?: string };
type McpState = {
  requests?: ProjectedRequest[];
  toolNames?: Record<string, string>;
};
function Approval({ item }: { item: ProjectedRequest }) {
  const { id } = useExtensionContext(),
    { t } = useLocale();
  const inFlight = useRef(false);
  const [sending, setSending] = useState(false),
    [error, setError] = useState('');
  const expired = item.deadline <= Date.now();
  const status: ApprovalState =
    item.status === 'pending'
      ? 'request'
      : item.status === 'approved' || item.status === 'dispatching'
        ? 'running'
        : item.status === 'rejected' || item.status === 'stopped'
          ? 'denied'
          : 'done';
  async function decide(decision: 'approved' | 'rejected') {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setError('');
    try {
      await request(`/conversations/${id}/extensions/mcp/controls/decide`, {
        method: 'POST',
        body: JSON.stringify({ parentId: item.parentId, decision }),
      });
      // Keep the controls disabled until the authoritative Pi projection changes.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed');
      inFlight.current = false;
      setSending(false);
    }
  }
  if (item.status === 'completed') return null;
  if (item.status === 'unknown')
    return (
      <Alert role="status" className="my-2">
        <AlertDescription className="text-xs">
          {t(
            'The remote outcome is unknown. Check the external service before taking further action. This operation will not be replayed automatically.',
          )}
        </AlertDescription>
      </Alert>
    );
  return (
    <div className="my-2 space-y-2" data-slot="mcp-approval">
      <ApprovalCard
        state={status}
        title={item.toolName}
        subtitle={item.connectionName}
        icon={<Plug className="size-4" />}
        command={JSON.stringify(JSON.parse(item.args), null, 2)}
        description={
          expired && status === 'request'
            ? t('This approval has expired.')
            : t('Allow this tool call? The arguments below will be sent to this server.')
        }
        allowOnceLabel={t('Allow once')}
        denyLabel={t('Reject')}
        statusLabel={t(
          status === 'running' ? 'Approved, running' : status === 'denied' ? 'Denied' : 'Finished',
        )}
        disabled={sending || expired}
        onAllowOnce={() => void decide('approved')}
        onDeny={() => void decide('rejected')}
        aria-busy={sending}
        className="max-w-none"
      />
      {error && (
        <Alert variant="destructive">
          <AlertDescription className="text-xs">{t(error)}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
function McpToolApproval({ part }: { part: ToolCallMessagePartProps }) {
  const { state, messageIds } = useExtensionContext();
  const split = part.toolCallId.indexOf('.');
  const canonical =
    split < 0
      ? part.toolCallId
      : canonicalMessageId(part.toolCallId.slice(0, split), messageIds) +
        part.toolCallId.slice(split);
  const item = (state?.mcp as McpState | undefined)?.requests?.find(
    (r) => r.toolCallId === canonical,
  );
  return item ? <Approval key={item.parentId} item={item} /> : null;
}
function McpPendingApprovals() {
  const { state } = useExtensionContext();
  const requests = (state?.mcp as McpState | undefined)?.requests?.filter(
    (r) => r.status === 'unknown' || (!r.toolCallId && r.status === 'pending'),
  );
  if (!requests?.length) return null;
  return (
    <div className="mb-3 space-y-2" data-slot="mcp-pending-approvals">
      {requests.map((item) => (
        <Approval key={item.parentId} item={item} />
      ))}
    </div>
  );
}
export const ui: ExtensionUI = {
  composerFooter: McpPendingApprovals,
  toolFooter: McpToolApproval,
  toolDisplayName: (name, state) => (state?.mcp as McpState | undefined)?.toolNames?.[name],
};
