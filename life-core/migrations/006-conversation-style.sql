BEGIN;
ALTER TABLE life_conversations ADD COLUMN style_floor_seq bigint NOT NULL DEFAULT 0;
CREATE TABLE life_style_profiles (
  conversation text PRIMARY KEY REFERENCES life_conversations(key) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 1, sample_count integer NOT NULL, speaker_count integer NOT NULL,
  median_chars integer NOT NULL, emoji_rate double precision NOT NULL,
  source_ids uuid[] NOT NULL, to_seq bigint NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE life_style_rules (
  id uuid PRIMARY KEY, conversation text NOT NULL REFERENCES life_conversations(key) ON DELETE CASCADE,
  fingerprint text NOT NULL, expression text NOT NULL, function text NOT NULL, meaning text NOT NULL,
  context text NOT NULL, avoid text NOT NULL, confidence double precision NOT NULL CHECK(confidence>=0 AND confidence<=1),
  status text NOT NULL CHECK(status IN ('candidate','active','suppressed')), revision integer NOT NULL DEFAULT 1,
  last_seen_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(conversation,fingerprint)
);
CREATE TABLE life_style_evidence (
  rule_id uuid NOT NULL REFERENCES life_style_rules(id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES life_events(id) ON DELETE CASCADE,
  quote text NOT NULL, actor text NOT NULL, PRIMARY KEY(rule_id,event_id)
);
CREATE TABLE life_style_revisions (
  rule_id uuid NOT NULL REFERENCES life_style_rules(id) ON DELETE CASCADE,
  revision integer NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(rule_id,revision)
);
INSERT INTO life_settings VALUES('style_learning_paused','false');
GRANT SELECT,INSERT,UPDATE ON life_style_profiles,life_style_rules TO life_app;
GRANT SELECT,INSERT ON life_style_evidence,life_style_revisions TO life_app;
INSERT INTO life_migrations(version) VALUES(6);
COMMIT;
