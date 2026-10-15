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
