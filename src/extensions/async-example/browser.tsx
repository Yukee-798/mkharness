import { useRef, useState } from 'react';
import { useExtensionContext } from '../../browser/extension-context';
import { useLocale } from '../../browser/locale';
import { Button } from '../../browser/ui/button';
import type { ExtensionUI } from '../../browser/extensions';
import { ASYNC_EXAMPLE_ID, remoteActionSource } from './contracts';
import type { RemoteProgress } from './progress';

function Progress() {
  const { state, submit, busy } = useExtensionContext();
  const { t } = useLocale();
  const remote = Array.isArray(state?.[ASYNC_EXAMPLE_ID])
    ? (state[ASYNC_EXAMPLE_ID] as RemoteProgress[])
    : [];
  const [remoteSending, setRemoteSending] = useState(false);
  const sending = useRef(false);
  const remoteAction = async (name: 'retry' | 'recheck', taskId: number) => {
    if (sending.current || busy) return;
    sending.current = true;
    setRemoteSending(true);
    try {
      await submit(
        name === 'retry' ? t('重新执行原任务（可能重复执行）') : t('复查原任务'),
        remoteActionSource(name, taskId),
      );
    } catch {
      // The host submission receipt displays failures and keeps retry identity stable.
    } finally {
      sending.current = false;
      setRemoteSending(false);
    }
  };
  return (
    <div className="space-y-3 empty:hidden mb-3">
      {remote
        .filter((o) =>
          [
            'prepared',
            'submitting',
            'waiting',
            'unknown',
            'timeout',
            'cancel_unknown',
            'cancel_failed',
            'cancel_unsupported',
          ].includes(o.status),
        )
        .map((operation) => {
          const blocked = !['prepared', 'submitting', 'waiting'].includes(operation.status);
          const labels: Record<string, string> = {
            prepared: t('正在准备执行…'),
            submitting: t('正在提交请求…'),
            waiting: t('正在等待结果…'),
            unknown: t('结果暂时无法确认'),
            timeout: t('等待已到期，远端可能仍在运行'),
            cancel_unknown: t('已停止本地任务，远端状态尚未确认'),
            cancel_failed: t('已停止本地任务，远端取消未成功'),
            cancel_unsupported: t('已停止本地任务，远端不支持取消'),
          };
          return (
            <div
              key={operation.taskId}
              role="status"
              data-slot="remote-progress"
              className="rounded-lg border px-3 py-2 text-xs text-muted-foreground"
            >
              <p>{labels[operation.status]}</p>
              {blocked && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={remoteSending || busy}
                    onClick={() => void remoteAction('recheck', operation.taskId)}
                  >
                    {t('复查原任务')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={remoteSending || busy}
                    onClick={() => void remoteAction('retry', operation.taskId)}
                  >
                    {t('重新执行（可能重复执行）')}
                  </Button>
                </div>
              )}
            </div>
          );
        })}
    </div>
  );
}

export const ui: ExtensionUI = { composerFooter: Progress };
