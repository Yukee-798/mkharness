import { DurableObjectOAuthClientProvider } from 'agents/mcp/do-oauth-client-provider';
import { SecretStore } from './secrets';

/** SDK owns discovery, registration, PKCE/state validation and token exchange. */
export class ConnectionOAuth extends DurableObjectOAuthClientProvider {
  constructor(
    storage: DurableObjectStorage,
    private secrets: SecretStore,
    private connectionId: string,
    callback: string,
    private appUrl: string,
  ) {
    super(storage, 'mkharness', callback);
    this.serverId = connectionId;
  }
  get clientMetadataUrl() {
    return this.appUrl.startsWith('https:')
      ? new URL('/api/mcp/client-metadata', this.appUrl).href
      : undefined;
  }
  override async clientInformation() {
    const info =
      await this.secrets.get<
        Awaited<ReturnType<DurableObjectOAuthClientProvider['clientInformation']>>
      >('client');
    if (info) this.clientId = info.client_id;
    return info;
  }
  override async saveClientInformation(
    info: Parameters<DurableObjectOAuthClientProvider['saveClientInformation']>[0],
  ) {
    this.clientId = info.client_id;
    await this.secrets.put('client', info);
  }
  override async tokens() {
    return this.secrets.get<Awaited<ReturnType<DurableObjectOAuthClientProvider['tokens']>>>(
      'tokens',
    );
  }
  override async saveTokens(tokens: Parameters<DurableObjectOAuthClientProvider['saveTokens']>[0]) {
    await this.secrets.put('tokens', tokens);
    await this.storage.delete(this.discoveryStateKey());
  }
  override async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ) {
    if (scope === 'all' || scope === 'client') await this.secrets.delete('client');
    if (scope === 'all' || scope === 'tokens') await this.secrets.delete('tokens');
    await super.invalidateCredentials(scope);
  }
}
