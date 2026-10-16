/** Opt-in plaintext storage. Never used for request authentication or automatic re-upload. */
const prefix = 'mkharness:model-key:';
type RememberedKey = { currentId: string; apiKey: string };
const storageKey = (userId: string, provider: string) =>
  prefix + JSON.stringify([userId, provider]);
export function readModelKey(userId: string, provider: string, currentId: string | null) {
  try {
    const raw = localStorage.getItem(storageKey(userId, provider));
    if (!raw) return undefined;
    const value: unknown = JSON.parse(raw);
    if (
      value &&
      typeof value === 'object' &&
      'currentId' in value &&
      value.currentId === currentId &&
      'apiKey' in value &&
      typeof value.apiKey === 'string' &&
      value.apiKey.length > 0 &&
      value.apiKey.length <= 8192
    )
      return value as RememberedKey;
    localStorage.removeItem(storageKey(userId, provider));
  } catch {
    /* Unavailable browser storage is optional. */
  }
  return undefined;
}
export function rememberModelKey(userId: string, provider: string, value?: RememberedKey) {
  try {
    if (value) localStorage.setItem(storageKey(userId, provider), JSON.stringify(value));
    else localStorage.removeItem(storageKey(userId, provider));
    return true;
  } catch {
    return false;
  }
}
/** Session changes clear other identities without touching unrelated application storage. */
export function retainModelKeys(userId?: string) {
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(prefix)) continue;
      let owner: unknown;
      try {
        owner = JSON.parse(key.slice(prefix.length))[0];
      } catch {
        /* Remove malformed records. */
      }
      if (!userId || owner !== userId) localStorage.removeItem(key);
    }
  } catch {
    /* Optional storage may be disabled. */
  }
}
