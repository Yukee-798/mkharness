-- Native Pi fresh-install baseline. Apply only to a new, empty D1 database.
-- Existing installations must use separate resources. This is not an upgrade.
CREATE TABLE user (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  emailVerified INTEGER NOT NULL,
  image TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  isAnonymous INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE session (
  id TEXT PRIMARY KEY NOT NULL,
  expiresAt INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  ipAddress TEXT,
  userAgent TEXT,
  userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE
);
CREATE INDEX session_userId_idx ON session(userId);

CREATE TABLE account (
  id TEXT PRIMARY KEY NOT NULL,
  accountId TEXT NOT NULL,
  providerId TEXT NOT NULL,
  userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  accessToken TEXT,
  refreshToken TEXT,
  idToken TEXT,
  accessTokenExpiresAt INTEGER,
  refreshTokenExpiresAt INTEGER,
  scope TEXT,
  password TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX account_userId_idx ON account(userId);

CREATE TABLE verification (
  id TEXT PRIMARY KEY NOT NULL,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expiresAt INTEGER NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX verification_identifier_idx ON verification(identifier);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  create_request_id TEXT NOT NULL,
  create_hash TEXT NOT NULL,
  instance_generation TEXT NOT NULL,
  lifecycle TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle IN ('active', 'deleting', 'deleted')),
  title TEXT,
  title_custom INTEGER DEFAULT 0,
  created_at INTEGER,
  updated_at INTEGER,
  UNIQUE(owner, create_request_id),
  CHECK (
    (lifecycle IN ('active', 'deleting') AND title IS NOT NULL AND title_custom IS NOT NULL
      AND created_at IS NOT NULL AND updated_at IS NOT NULL)
    OR
    (lifecycle = 'deleted' AND title IS NULL AND title_custom IS NULL
      AND created_at IS NULL AND updated_at IS NULL)
  )
);
CREATE INDEX conversations_owner_time ON conversations(owner, lifecycle, updated_at, id);

CREATE TABLE model_credentials (
  id TEXT PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  envelope_version INTEGER NOT NULL CHECK(envelope_version=1),
  base_url TEXT,
  model_id TEXT,
  created_at INTEGER NOT NULL,
  retired_at INTEGER
);
CREATE UNIQUE INDEX model_credentials_current ON model_credentials(owner,provider) WHERE retired_at IS NULL;
CREATE INDEX model_credentials_owner ON model_credentials(owner,provider);

CREATE TABLE mcp_connections (
  id TEXT PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX mcp_connections_owner ON mcp_connections(owner,created_at);

CREATE TABLE conversation_mcp_bindings (
  conversation TEXT PRIMARY KEY NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  bindings TEXT NOT NULL
);

CREATE TABLE conversation_deployment_mcp_bindings (
  conversation TEXT PRIMARY KEY NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  bindings TEXT NOT NULL
);

CREATE TABLE skills (
  id TEXT PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  current_version TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE UNIQUE INDEX skills_owner_name ON skills(owner,name) WHERE deleted_at IS NULL;

CREATE TABLE skill_versions (
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  prefix TEXT NOT NULL,
  preview TEXT NOT NULL,
  PRIMARY KEY(skill_id,version)
);

CREATE TABLE conversation_skill_bindings (
  conversation TEXT PRIMARY KEY NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  bindings TEXT NOT NULL
);
