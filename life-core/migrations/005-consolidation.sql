BEGIN;
ALTER TABLE life_conversations ADD COLUMN memory_epoch integer NOT NULL DEFAULT 0;
ALTER TABLE life_conversations ADD COLUMN memory_floor_seq bigint NOT NULL DEFAULT 0;
CREATE TABLE life_memory_cursors (
  conversation text NOT NULL REFERENCES life_conversations(key) ON DELETE CASCADE,
  actor text NOT NULL, last_seq bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(conversation,actor)
);
-- Enabling this feature does not bulk-extract old conversations.
INSERT INTO life_memory_cursors(conversation,actor,last_seq)
  SELECT e.conversation,e.actor,max(e.seq) FROM life_events e JOIN life_conversations c ON c.key=e.conversation
  WHERE e.kind='inbound.message' AND e.actor IS NOT NULL GROUP BY e.conversation,e.actor;
CREATE TABLE life_memory_tasks (
  id uuid PRIMARY KEY, conversation text NOT NULL REFERENCES life_conversations(key) ON DELETE CASCADE,
  actor text NOT NULL, anchor_id uuid NOT NULL REFERENCES life_events(id) ON DELETE CASCADE,
  source_ids uuid[] NOT NULL, from_seq bigint NOT NULL, to_seq bigint NOT NULL, epoch integer NOT NULL,
  status text NOT NULL CHECK(status IN ('pending','running','done','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0, owner uuid, lease_until timestamptz,
  due_at timestamptz NOT NULL DEFAULT now(), plan jsonb, result jsonb, error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX life_memory_tasks_open ON life_memory_tasks(conversation,actor) WHERE status IN ('pending','running');
CREATE INDEX life_memory_tasks_claim ON life_memory_tasks(status,due_at,created_at);
CREATE INDEX life_memory_sources ON life_events(conversation,actor,seq) WHERE kind='inbound.message';
CREATE TABLE life_memory_calls (
  id uuid PRIMARY KEY, task_id uuid REFERENCES life_memory_tasks(id) ON DELETE SET NULL,
  reserved_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, usage jsonb, error text
);
CREATE INDEX life_memory_calls_window ON life_memory_calls(reserved_at);
INSERT INTO life_settings VALUES('consolidation_paused','false');
GRANT SELECT,INSERT,UPDATE ON life_memory_cursors,life_memory_tasks TO life_app;
GRANT SELECT,INSERT ON life_memory_calls TO life_app;
GRANT UPDATE(finished_at,usage,error) ON life_memory_calls TO life_app;
INSERT INTO life_migrations(version) VALUES(5);
COMMIT;
