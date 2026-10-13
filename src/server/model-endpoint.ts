import { isIP } from 'node:net';
import { AppError } from '../shared/contracts';
import { publicAddress, resolvePublicAddresses } from './web';

/** Client-configured destinations are public HTTPS APIs, without credentials in the URL. */
export function modelBaseUrl(raw: string) {
  try {
    if (
      raw.length > 2048 ||
      /\s/.test(raw.trim()) ||
      Array.from(raw).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    )
      throw new Error('invalid URL');
    const url = new URL(raw.trim());
    const host = url.hostname
      .replace(/^\[|\]$/g, '')
      .toLowerCase()
      .replace(/\.$/, '');
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (!host.includes('.') && !isIP(host)) ||
      /(^|\.)(localhost|local|internal|home|lan)$/.test(host) ||
      (isIP(host) && !publicAddress(host))
    )
      throw new Error('invalid destination');
    return url.href.replace(/\/+$/, '');
  } catch {
    throw new AppError(
      400,
      'invalid_base_url',
      'Base URL 必须是公开 HTTPS 地址，不能包含账号、密码、查询参数或片段',
    );
  }
}

/** Keep bearer credentials at their accepted destination; never follow redirects. */
export function modelEndpointFetch(baseUrl: string, fetcher: typeof fetch = fetch): typeof fetch {
  const base = new URL(modelBaseUrl(baseUrl));
  return async (input, init) => {
    const target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (
      target.origin !== base.origin ||
      !(
        target.pathname === base.pathname ||
        target.pathname.startsWith(base.pathname.replace(/\/+$/, '') + '/')
      )
    ) {
      throw new Error('Model request escaped its accepted Base URL');
    }
    const host = base.hostname.replace(/^\[|\]$/g, '');
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = AbortSignal.any([
      ...(callerSignal ? [callerSignal] : []),
      AbortSignal.timeout(15000),
    ]);
    const addresses = isIP(host) ? [host] : await resolvePublicAddresses(host, signal);
    if (!addresses.length || addresses.some((ip) => !publicAddress(ip)))
      throw new Error('Model endpoint must resolve to public addresses');
    // DNS checks are defense in depth, not IP pinning. Hosting platforms must enforce network isolation.
    return fetcher(input, { ...init, redirect: 'error' });
  };
}
