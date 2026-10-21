BEGIN;
CREATE TABLE life_memories (
  id uuid PRIMARY KEY,
  conversation text NOT NULL REFERENCES life_conversations(key) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('semantic','episodic')),
  subject_type text NOT NULL CHECK (subject_type IN ('user','group','project')),
  subject_id text NOT NULL, subject_label text NOT NULL,
  slot text, content text NOT NULL, summary text NOT NULL,
  confidence real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  importance real NOT NULL CHECK (importance BETWEEN 0 AND 1),
  sensitivity text NOT NULL CHECK (sensitivity IN ('internal','sensitive')),
  status text NOT NULL CHECK (status IN ('active','candidate','forgotten')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  content_hash text NOT NULL, search_terms text NOT NULL,
  search_document tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, search_terms)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,
  UNIQUE(conversation,content_hash)
);
CREATE INDEX life_memories_scope_status ON life_memories(conversation,status,updated_at DESC);
CREATE INDEX life_memories_fts ON life_memories USING GIN(search_document);
CREATE TABLE life_memory_revisions (
  memory_id uuid NOT NULL REFERENCES life_memories(id) ON DELETE CASCADE,
  revision integer NOT NULL, snapshot jsonb NOT NULL, reason text NOT NULL, actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(memory_id,revision)
);
CREATE TABLE life_memory_evidence (
  memory_id uuid NOT NULL, revision integer NOT NULL,
  event_id uuid NOT NULL REFERENCES life_events(id) ON DELETE CASCADE,
  quote text NOT NULL, source_actor text, source_kind text NOT NULL, weight real NOT NULL,
  PRIMARY KEY(memory_id,revision,event_id),
  FOREIGN KEY(memory_id,revision) REFERENCES life_memory_revisions(memory_id,revision) ON DELETE CASCADE
);
CREATE INDEX life_memory_evidence_event ON life_memory_evidence(event_id);
CREATE TABLE life_memory_links (
  source_id uuid NOT NULL REFERENCES life_memories(id) ON DELETE CASCADE,
  target_id uuid NOT NULL REFERENCES life_memories(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('related','contradicts','supports')),
  reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(source_id,target_id,kind), CHECK (source_id<>target_id)
);
CREATE TABLE life_memory_ops (
  key text PRIMARY KEY, conversation text NOT NULL REFERENCES life_conversations(key) ON DELETE CASCADE,
  fingerprint text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO life_settings VALUES ('memory_writes_paused','false');
GRANT SELECT,INSERT,UPDATE ON life_memories TO life_app;
GRANT SELECT,INSERT ON life_memory_revisions,life_memory_evidence,life_memory_links,life_memory_ops TO life_app;
INSERT INTO life_migrations(version) VALUES(3);
COMMIT;
