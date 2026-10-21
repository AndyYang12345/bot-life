BEGIN;
CREATE TABLE life_image_labels (
  event_id uuid NOT NULL REFERENCES life_events(id) ON DELETE CASCADE,
  hash text NOT NULL REFERENCES life_blobs(hash),
  kind text NOT NULL CHECK(kind IN ('meme','informational','mixed','uncertain')),
  description text NOT NULL, tags text[] NOT NULL, use_when text NOT NULL, avoid_when text NOT NULL,
  confidence double precision NOT NULL CHECK(confidence>=0 AND confidence<=1),
  reusable boolean NOT NULL, privacy_risk boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(event_id,hash)
);
CREATE TABLE life_memes (
  id uuid PRIMARY KEY, conversation text NOT NULL REFERENCES life_conversations(key) ON DELETE CASCADE,
  hash text NOT NULL REFERENCES life_blobs(hash), source_id uuid NOT NULL REFERENCES life_events(id) ON DELETE CASCADE,
  description text NOT NULL, tags text[] NOT NULL, use_when text NOT NULL, avoid_when text NOT NULL,
  status text NOT NULL CHECK(status IN ('active','suppressed')), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(conversation,hash)
);
CREATE INDEX life_memes_scope ON life_memes(conversation,status,created_at);
INSERT INTO life_settings VALUES('meme_learning_paused','false');
GRANT SELECT,INSERT ON life_image_labels,life_memes TO life_app;
INSERT INTO life_migrations(version) VALUES(7);
COMMIT;
