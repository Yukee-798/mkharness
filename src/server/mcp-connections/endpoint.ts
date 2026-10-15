import { isIP } from 'node:net';
import { publicAddress, resolvePublicAddresses } from '../web';
import { AppError } from '../../shared/contracts';

export function publicMcpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError(400, 'mcp_endpoint_invalid');
  }
  const host = url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (!host.includes('.') && !isIP(host)) ||
    /(^|\.)(localhost|local|internal|home|lan)$/.test(host) ||
    (isIP(host) && !publicAddress(host))
  )
    throw new AppError(400, 'mcp_endpoint_invalid');
  return url;
}

/** Applied to MCP AND SDK OAuth fetches. Network isolation remains the final egress boundary. */
export const mcpFetch: typeof fetch = async (input, init) => {
  const url = publicMcpUrl(String(input instanceof Request ? input.url : input));
  const signal = AbortSignal.any([
    ...(init?.signal
      ? [init.signal]
      : input instanceof Request && input.signal
        ? [input.signal]
        : []),
    AbortSignal.timeout(30_000),
  ]);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : await resolvePublicAddresses(host, signal);
  if (!addresses.length || addresses.some((address) => !publicAddress(address)))
    throw new AppError(400, 'mcp_endpoint_private');
  const response = await fetch(input, { ...init, signal, redirect: 'manual' });
  if (response.status >= 300 && response.status < 400)
    throw new AppError(503, 'mcp_redirect_blocked');
  if (!response.body) return response;
  let bytes = 0;
  return new Response(
    response.body.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          if (bytes > 2 * 1024 * 1024) throw new AppError(503, 'mcp_result_too_large');
          controller.enqueue(chunk);
        },
      }),
    ),
    { status: response.status, statusText: response.statusText, headers: response.headers },
  );
};
