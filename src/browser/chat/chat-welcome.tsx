import { MessageSquare } from 'lucide-react';
import { useLocale } from '../app/locale';

export function ChatWelcome() {
  const { t } = useLocale();
  return (
    <div data-slot="chat-welcome" className="mx-auto max-w-md shrink-0 px-6 text-center">
      <MessageSquare className="mx-auto mb-4 size-6 text-muted-foreground" />
      <p className="text-xl font-medium tracking-tight">{t('今天想解决什么问题？')}</p>
      <p className="mt-2 text-sm text-muted-foreground">
        {t('直接提问，或描述你想比较、计算和调整的内容。')}
      </p>
    </div>
  );
}
