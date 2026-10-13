import { modelBaseUrl } from './model-endpoint';
import { AppError } from '../shared/contracts';
import type { CredentialMetadata, CredentialRef } from '../shared/model-settings';
export type CredentialEnvironment = {
  DB: D1Database;
  CREDENTIAL_ENCRYPTION_KEY?: string;
  MODEL_API_KEY?: string;
  MODEL_PROVIDER?: string;
  ALLOW_SERVER_MODEL_KEY?: string;
};
export class ModelCredentials {
  constructor(
    private readonly env: CredentialEnvironment,
    private readonly owner: string,
    private readonly now = Date.now,
  ) {}
  get storageReady() {
    try {
      this.masterBytes();
      return true;
    } catch {
      return false;
    }
  }
  private masterBytes() {
    const text = this.env.CREDENTIAL_ENCRYPTION_KEY;
    if (!text || !/^[A-Za-z0-9+/]{43}=$/.test(text))
      throw new AppError(503, 'credential_storage_not_configured', '部署尚未配置凭据加密密钥');
    const bytes = decode(text);
    if (bytes.length !== 32) throw new AppError(503, 'credential_storage_not_configured');
    return bytes;
  }
  private async master() {
    return crypto.subtle.importKey('raw', this.masterBytes(), 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ]);
  }
  private serverAllowed(provider: string) {
    const enabled = this.env.ALLOW_SERVER_MODEL_KEY ?? '0';
    if (enabled !== '0' && enabled !== '1') throw new AppError(503, 'invalid_server_key_policy');
    return enabled === '1' && !!this.env.MODEL_API_KEY && this.env.MODEL_PROVIDER === provider;
  }
  private current(provider: string) {
    return this.env.DB.prepare(
      'SELECT id,created_at,base_url,model_id FROM model_credentials WHERE owner=? AND provider=? AND retired_at IS NULL',
    )
      .bind(this.owner, provider)
      .first<{
        id: string;
        created_at: number;
        base_url: string | null;
        model_id: string | null;
      }>();
  }
  async metadata(provider: string): Promise<CredentialMetadata> {
    const row = await this.current(provider),
      serverDefaultAllowed = this.serverAllowed(provider);
    return {
      provider,
      currentId: row?.id ?? null,
      baseUrl: row?.base_url ?? null,
      modelId: row?.model_id ?? null,
      configured: !!row,
      updatedAt: row?.created_at ?? null,
      effectiveSource: row ? 'user' : serverDefaultAllowed ? 'server' : 'none',
      serverDefaultAllowed,
    };
  }
  async configuredModels() {
    const { results } = await this.env.DB.prepare(
      'SELECT provider,model_id AS modelId FROM model_credentials WHERE owner=? AND retired_at IS NULL AND model_id IS NOT NULL',
    )
      .bind(this.owner)
      .all<{ provider: string; modelId: string }>();
    return results;
  }
  private cleanup(time: number) {
    return this.env.DB.prepare(
      'DELETE FROM model_credentials WHERE owner=? AND retired_at IS NOT NULL AND retired_at<=?',
    ).bind(this.owner, time - RETENTION);
  }
  async save(
    provider: string,
    input: { apiKey: string; baseUrl?: string; modelId?: string; expectedCurrentId: string | null },
  ): Promise<CredentialMetadata> {
    const text = input.apiKey.trim();
    if (
      !text ||
      Array.from(text).some(
        (c) => c.charCodeAt(0) < 32 || (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159),
      ) ||
      new TextEncoder().encode(text).byteLength > 8192
    )
      throw new AppError(400, 'invalid_api_key', 'Key 不能为空、包含控制字符或超过 8 KiB');
    const baseUrl = input.baseUrl === undefined ? null : modelBaseUrl(input.baseUrl);
    const id = crypto.randomUUID(),
      time = this.now(),
      nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad(id, this.owner, provider, baseUrl) },
      await this.master(),
      new TextEncoder().encode(text),
    );
    const results = await this.env.DB.batch([
      this.cleanup(time),
      this.env.DB.prepare(
        'UPDATE model_credentials SET retired_at=? WHERE owner=? AND provider=? AND id=? AND retired_at IS NULL AND (SELECT COUNT(*) FROM model_credentials WHERE owner=? AND provider=?)<20',
      ).bind(time, this.owner, provider, input.expectedCurrentId, this.owner, provider),
      this.env.DB.prepare(
        'INSERT INTO model_credentials(id,owner,provider,ciphertext,nonce,envelope_version,created_at,base_url,model_id) SELECT ?,?,?,?,?,1,?,?,? WHERE (changes()=1 OR (? IS NULL AND NOT EXISTS(SELECT 1 FROM model_credentials WHERE owner=? AND provider=? AND retired_at IS NULL))) AND (SELECT COUNT(*) FROM model_credentials WHERE owner=? AND provider=?)<20 RETURNING id',
      ).bind(
        id,
        this.owner,
        provider,
        encode(new Uint8Array(ciphertext)),
        encode(nonce),
        time,
        baseUrl,
        input.modelId ?? null,
        input.expectedCurrentId,
        this.owner,
        provider,
        this.owner,
        provider,
      ),
    ]);
    if (!results[2].results.length) {
      if ((await this.current(provider))?.id !== (input.expectedCurrentId ?? undefined))
        throw new AppError(409, 'credential_conflict', '凭据已在其他页面更新，请重新读取后再保存');
      const count = await this.env.DB.prepare(
        'SELECT COUNT(*) AS n FROM model_credentials WHERE owner=? AND provider=?',
      )
        .bind(this.owner, provider)
        .first<number>('n');
      if ((count ?? 0) >= 20)
        throw new AppError(
          429,
          'credential_version_limit',
          '有效凭据版本已达上限；移除将撤销未完成请求的凭据',
        );
      throw new AppError(409, 'credential_conflict');
    }
    return this.metadata(provider);
  }
  async remove(provider: string, expectedCurrentId: string | null): Promise<CredentialMetadata> {
    const time = this.now();
    await this.env.DB.batch([
      this.cleanup(time),
      this.env.DB.prepare(
        'UPDATE model_credentials SET retired_at=? WHERE owner=? AND provider=? AND id=? AND retired_at IS NULL',
      ).bind(time, this.owner, provider, expectedCurrentId),
      this.env.DB.prepare(
        'DELETE FROM model_credentials WHERE owner=? AND provider=? AND (changes()=1 OR (? IS NULL AND NOT EXISTS(SELECT 1 FROM model_credentials WHERE owner=? AND provider=? AND retired_at IS NULL)))',
      ).bind(this.owner, provider, expectedCurrentId, this.owner, provider),
    ]);
    const remaining = await this.env.DB.prepare(
      'SELECT COUNT(*) AS n FROM model_credentials WHERE owner=? AND provider=?',
    )
      .bind(this.owner, provider)
      .first<number>('n');
    if (remaining)
      throw new AppError(409, 'credential_conflict', '凭据已在其他页面更新，请重新读取后再移除');
    return this.metadata(provider);
  }
  async select(provider: string): Promise<CredentialRef> {
    const row = await this.current(provider);
    if (row) return { source: 'user', id: row.id };
    if (this.serverAllowed(provider))
      return { source: 'server', fingerprint: await this.fingerprint(provider) };
    throw new AppError(400, 'credential_required', '请先配置所选模型的 Base URL 与 API Key');
  }
  private async fingerprint(provider: string) {
    return encode(
      new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(
            JSON.stringify(['mkharness:server-model-key:v1', provider, this.env.MODEL_API_KEY]),
          ),
        ),
      ),
    );
  }
  async resolve(
    provider: string,
    ref: CredentialRef,
  ): Promise<{ apiKey: string; baseUrl?: string }> {
    if (ref.source === 'server') {
      if (!this.serverAllowed(provider))
        throw new AppError(503, 'credential_unavailable', '原请求的部署凭据当前不可用');
      if ((await this.fingerprint(provider)) !== ref.fingerprint)
        throw new AppError(
          503,
          'credential_configuration_changed',
          '原请求的部署凭据已更改，请发起新请求',
        );
      return { apiKey: this.env.MODEL_API_KEY! };
    }
    const row = await this.env.DB.prepare(
      'SELECT ciphertext,nonce,envelope_version,retired_at,base_url FROM model_credentials WHERE owner=? AND provider=? AND id=?',
    )
      .bind(this.owner, provider, ref.id)
      .first<{
        ciphertext: string;
        nonce: string;
        envelope_version: number;
        retired_at: number | null;
        base_url: string | null;
      }>();
    if (!row || (row.retired_at !== null && this.now() >= row.retired_at + RETENTION))
      throw new AppError(
        503,
        'credential_unavailable',
        '原请求的个人凭据已撤销或过期，请发起新请求',
      );
    const key = await this.master();
    try {
      if (row.envelope_version !== 1 || decode(row.nonce).length !== 12)
        throw new Error('invalid envelope');
      const apiKey = new TextDecoder('utf-8', { fatal: true }).decode(
        await crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: decode(row.nonce),
            additionalData: aad(ref.id, this.owner, provider, row.base_url),
          },
          key,
          decode(row.ciphertext),
        ),
      );
      return { apiKey, ...(row.base_url ? { baseUrl: modelBaseUrl(row.base_url) } : {}) };
    } catch {
      throw new AppError(
        503,
        'credential_decryption_failed',
        '个人凭据无法解密，请检查部署主密钥并重新配置',
      );
    }
  }
}
const RETENTION = 7 * 86400000;
function encode(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}
function decode(text: string) {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}
function aad(id: string, owner: string, provider: string, baseUrl: string | null) {
  // The destination is authenticated with the Key; editing it cannot redirect a stored secret.
  return new TextEncoder().encode(
    JSON.stringify([1, id, owner, provider, ...(baseUrl ? [baseUrl] : [])]),
  );
}
