BEGIN;
ALTER TABLE life_conversations ADD COLUMN attention_floor_seq bigint NOT NULL DEFAULT 0;
CREATE TABLE life_attention_aliases (
  id uuid PRIMARY KEY, conversation text NOT NULL REFERENCES life_conversations(key) ON DELETE CASCADE,
  alias text NOT NULL, status text NOT NULL CHECK(status IN ('candidate','active','suppressed')),
  confidence double precision NOT NULL, revision integer NOT NULL DEFAULT 1,
  last_seen_at timestamptz NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(conversation,alias)
);
CREATE TABLE life_attention_evidence (
  alias_id uuid NOT NULL REFERENCES life_attention_aliases(id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES life_events(id) ON DELETE CASCADE,
  actor text NOT NULL, quote text NOT NULL, directed boolean NOT NULL,
  PRIMARY KEY(alias_id,event_id)
);
CREATE TABLE life_attention_revisions (
  alias_id uuid NOT NULL REFERENCES life_attention_aliases(id) ON DELETE CASCADE,
  revision integer NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(alias_id,revision)
);
INSERT INTO life_settings VALUES('attention_learning_paused','false');
GRANT SELECT,INSERT,UPDATE ON life_attention_aliases TO life_app;
GRANT SELECT,INSERT ON life_attention_evidence,life_attention_revisions TO life_app;
INSERT INTO life_migrations(version) VALUES(9);
COMMIT;
