import { authClient } from './auth';
let pending: Promise<void> | undefined;
/** Recheck the native cookie before creating a guest; StrictMode shares this flight. */
export function ensureGuestSession() {
  return (pending ??= (async () => {
    const current = await authClient.getSession();
    if (current.error) throw new Error('无法恢复浏览器身份，请重试');
    if (current.data) return;
    const created = await authClient.signIn.anonymous();
    if (created.error) {
      // A second tab can establish the shared cookie while this request is in flight.
      const session = await authClient.getSession();
      if (!session.data) throw new Error('无法建立浏览器身份，请重试');
    }
  })().finally(() => {
    pending = undefined;
  }));
}
