-- Existing chats keep their DO name, history, receipts and resource paths.
CREATE TABLE IF NOT EXISTS scenario_instances (
  id TEXT PRIMARY KEY NOT NULL,
  main_chat_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL UNIQUE,
  runtime_name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'agent'
);
INSERT OR IGNORE INTO scenario_instances(id,main_chat_id,workspace_id,runtime_name,kind)
  SELECT id,id,'workspace:' || id,id,'agent' FROM conversations;
-- Compatibility for older clients and deployment fixtures. New code replaces these
-- initial identifiers within the same creation transaction, before visibility.
CREATE TRIGGER IF NOT EXISTS scenario_from_chat AFTER INSERT ON conversations BEGIN
  INSERT INTO scenario_instances(id,main_chat_id,workspace_id,runtime_name,kind)
    VALUES(NEW.id,NEW.id,'workspace:' || NEW.id,NEW.id,'agent');
END;
CREATE INDEX IF NOT EXISTS scenario_kind ON scenario_instances(kind,main_chat_id);
