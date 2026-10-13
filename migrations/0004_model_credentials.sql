CREATE TABLE model_credentials (
  id TEXT PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  envelope_version INTEGER NOT NULL CHECK(envelope_version=1),
  created_at INTEGER NOT NULL,
  retired_at INTEGER
);
CREATE UNIQUE INDEX model_credentials_current ON model_credentials(owner,provider) WHERE retired_at IS NULL;
CREATE INDEX model_credentials_owner ON model_credentials(owner,provider);
