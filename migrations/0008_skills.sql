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
