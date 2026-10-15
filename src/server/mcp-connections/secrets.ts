import { AppError } from '../../shared/contracts';

type Envelope = { version: 1; iv: number[]; data: number[] };
/** Shared envelope primitive; OAuth state never uses model-credential version semantics. */
export async function secretKey(env: { CREDENTIAL_ENCRYPTION_KEY?: string }) {
  const raw = env.CREDENTIAL_ENCRYPTION_KEY;
  if (!raw || !/^[A-Za-z0-9+/]{43}=$/.test(raw))
    throw new AppError(503, 'credential_storage_not_configured');
  const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  if (bytes.length !== 32) throw new AppError(503, 'credential_storage_not_configured');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(key: CryptoKey, scope: string, value: unknown): Promise<Envelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(scope) },
    key,
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return { version: 1, iv: [...iv], data: [...new Uint8Array(data)] };
}
export async function unseal<T>(key: CryptoKey, scope: string, envelope: Envelope): Promise<T> {
  if (envelope.version !== 1) throw new AppError(503, 'credential_unavailable');
  const data = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: new Uint8Array(envelope.iv),
      additionalData: new TextEncoder().encode(scope),
    },
    key,
    new Uint8Array(envelope.data),
  );
  return JSON.parse(new TextDecoder().decode(data)) as T;
}
export class SecretStore {
  constructor(
    private storage: DurableObjectStorage,
    private key: Promise<CryptoKey>,
    private scope: string,
  ) {}
  async get<T>(name: string): Promise<T | undefined> {
    const value = await this.storage.get<Envelope>('secret:' + name);
    return value ? unseal<T>(await this.key, this.scope + ':' + name, value) : undefined;
  }
  async put(name: string, value: unknown) {
    await this.storage.put(
      'secret:' + name,
      await seal(await this.key, this.scope + ':' + name, value),
    );
  }
  async delete(name: string) {
    await this.storage.delete('secret:' + name);
  }
}
