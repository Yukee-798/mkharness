import { useLocale } from '../app/locale';
import { Skeleton } from '../ui/skeleton';

export function ChatLoading() {
  const { t } = useLocale();
  return (
    <div role="status" className="mx-auto w-full max-w-3xl flex-1 space-y-6 px-4 pt-8 sm:px-6">
      <span className="sr-only">{t('正在恢复聊天…')}</span>
      <Skeleton className="ml-auto h-10 w-2/5 rounded-2xl" />
      <div className="space-y-2" aria-hidden="true">
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-3/5" />
        <Skeleton className="h-4 w-2/5" />
      </div>
    </div>
  );
}
