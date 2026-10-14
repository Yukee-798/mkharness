/** Sources are external pages, never executable, relative, or credential-bearing URLs. */
export function safeHref(raw: string | undefined) {
  if (typeof raw !== 'string') return;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
    url.hash = '';
    return url.href;
  } catch {
    return;
  }
}
export function hostOf(raw: string | undefined) {
  const href = safeHref(raw);
  return href ? new URL(href).hostname.replace(/^www\./, '') : undefined;
}
