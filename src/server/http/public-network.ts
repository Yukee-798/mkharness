import { isIP } from 'node:net';
import { boundedText } from './body';

export function publicAddress(raw: string) {
  const ip = raw.replace(/^\[|\]$/g, '');
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || b === 2)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(ip) === 6)
    return (
      /^[23][0-9a-f]{3}:/i.test(ip) && !/^2001:(db8|0|10|20):/i.test(ip) && !/^2002:/i.test(ip)
    );
  return false;
}
export async function resolvePublicAddresses(
  host: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const answers = await Promise.all(
    ['A', 'AAAA'].map(async (type) => {
      const url = new URL('https://cloudflare-dns.com/dns-query');
      url.searchParams.set('name', host);
      url.searchParams.set('type', type);
      const response = await fetcher(url, {
        headers: { Accept: 'application/dns-json' },
        signal,
      });
      if (!response.ok) throw new Error('Public DNS lookup failed');
      const body = JSON.parse(await boundedText(response, 65536)) as {
        Answer?: { type: number; data: unknown }[];
      };
      return (body.Answer ?? [])
        .filter((a) => a.type === 1 || a.type === 28)
        .map((a) => String(a.data));
    }),
  );
  return answers.flat();
}
