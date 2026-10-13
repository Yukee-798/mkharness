import type { ModelCatalog } from './model-selection';
export type CredentialRef =
  { source: 'user'; id: string } | { source: 'server'; fingerprint: string };
export type CredentialMetadata = {
  provider: string;
  currentId: string | null;
  configured: boolean;
  updatedAt: number | null;
  effectiveSource: 'user' | 'server' | 'none';
  serverDefaultAllowed: boolean;
};
export type ModelSettings = {
  providers: { id: string; name: string }[];
  modelCatalog: ModelCatalog;
  credentials: CredentialMetadata[];
  credentialStorageReady: boolean;
};
