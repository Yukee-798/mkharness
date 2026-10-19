import { type ErrorComponentProps } from '@tanstack/react-router';
import { useLocale } from '../app/locale';
import { useCopyToClipboard } from '../hooks/use-copy-to-clipboard';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert';
import { Button } from '../ui/button';
import { conversationDiagnostics, isConversationStoreError } from './session/diagnostics';

export function ConversationError(props: ErrorComponentProps) {
  const { t } = useLocale();
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const storeError = isConversationStoreError(props.error);
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-xl items-center p-6">
      <Alert>
        <AlertTitle>{t(storeError ? '聊天视图暂时无法显示' : '页面暂时无法显示')}</AlertTitle>
        <AlertDescription>
          <p>
            {t(
              storeError
                ? '可以重新打开聊天以恢复显示。此操作不会重新提交生成任务。'
                : '可以重试打开页面。此操作不会重新提交任务。',
            )}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button onClick={props.reset}>{t(storeError ? '重新打开聊天' : '重试打开页面')}</Button>
            {storeError && (
              <Button variant="outline" onClick={() => copyToClipboard(conversationDiagnostics())}>
                {isCopied ? t('已复制') : t('复制诊断信息')}
              </Button>
            )}
          </div>
        </AlertDescription>
      </Alert>
    </div>
  );
}
