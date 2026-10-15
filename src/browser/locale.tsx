import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { english } from './messages';

export type Locale = 'en' | 'zh-CN';
export const localeStorageKey = 'mkharness.locale';
type Values = Record<string, string | number>;
const chinese: Record<string, string> = {
  queue_item_started: '这项任务已开始或结束，队列已刷新。',
  reply_not_found: '原回答不可用，请重新打开当前聊天后再试。',
  reply_context_unavailable: '原始输入不可用，请重新发送问题。',
  关闭思考: '关闭',
  Today: '今天',
  Earlier: '更早',
  'Interactive answer': '交互式回答',
  删除说明: '“{title}”的历史和填写内容将被删除，当前任务会停止，排队任务会撤回。此操作无法撤销。',
  显示失败说明: '内容暂时无法显示：{error}。可继续发送消息，填写内容仍保留。',
};
export function translate(locale: Locale, message: string, values: Values = {}) {
  const messages = locale === 'en' ? english : chinese;
  const text = Object.hasOwn(messages, message) ? messages[message]! : message;
  return text.replace(/\{(\w+)\}/g, (match, key: string) => String(values[key] ?? match));
}
function readLocale(): Locale {
  try {
    return localStorage.getItem(localeStorageKey) === 'zh-CN' ? 'zh-CN' : 'en';
  } catch {
    return 'en';
  }
}
const LocaleContext = createContext({
  locale: 'en' as Locale,
  setLocale: (_locale: Locale) => {},
  t: (message: string, values?: Values) => translate('en', message, values),
});
export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, updateLocale] = useState<Locale>(readLocale);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === localeStorageKey || event.key === null) updateLocale(readLocale());
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  const value = useMemo(
    () => ({
      locale,
      setLocale(next: Locale) {
        updateLocale(next);
        try {
          localStorage.setItem(localeStorageKey, next);
        } catch {
          // Language switching still works when persistent browser storage is unavailable.
        }
      },
      t: (message: string, values?: Values) => translate(locale, message, values),
    }),
    [locale],
  );
  return <LocaleContext value={value}>{children}</LocaleContext>;
}
export function useLocale() {
  return useContext(LocaleContext);
}
