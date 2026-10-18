import { createIsomorphicFn } from '@tanstack/react-start';
import { getCookie } from '@tanstack/react-start/server';
import { localeStorageKey, type Locale } from './locale';

// Loader data carries the same language into HTML and hydration, without an RPC.
export const initialLocale = createIsomorphicFn()
  .server((): Locale => (getCookie(localeStorageKey) === 'zh-CN' ? 'zh-CN' : 'en'))
  .client((): Locale => {
    try {
      return localStorage.getItem(localeStorageKey) === 'zh-CN' ? 'zh-CN' : 'en';
    } catch {
      return 'en';
    }
  });
