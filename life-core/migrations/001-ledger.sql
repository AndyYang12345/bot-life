BEGIN;
CREATE TABLE life_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE life_conversations (
  key text PRIMARY KEY, session_id text, generation integer NOT NULL DEFAULT 0
);
CREATE TABLE life_settings (key text PRIMARY KEY, value jsonb NOT NULL);
INSERT INTO life_settings VALUES ('paused', 'false');
CREATE TABLE life_events (
  id uuid PRIMARY KEY, seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  dedup_key text UNIQUE, conversation text NOT NULL, kind text NOT NULL,
  actor text, cause uuid REFERENCES life_events(id) ON DELETE CASCADE,
  occurred_at timestamptz, recorded_at timestamptz NOT NULL DEFAULT now(), payload jsonb NOT NULL
);
CREATE INDEX life_events_scope_seq ON life_events(conversation, seq);
CREATE INDEX life_events_cause ON life_events(cause);
CREATE TABLE life_jobs (
  id uuid PRIMARY KEY REFERENCES life_events(id) ON DELETE CASCADE,
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  conversation text NOT NULL REFERENCES life_conversations(key),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','skipped')),
  phase text NOT NULL DEFAULT 'pending' CHECK (phase IN ('pending','generating','ready')),
  attempts integer NOT NULL DEFAULT 0, owner uuid, lease_until timestamptz,
  due_at timestamptz NOT NULL DEFAULT now(), error text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX life_jobs_claim ON life_jobs(status, due_at, seq);
CREATE INDEX life_jobs_scope ON life_jobs(conversation, seq, status);
CREATE TABLE life_outbox (
  id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES life_jobs(id) ON DELETE CASCADE,
  part integer NOT NULL, payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','dispatching','confirmed','failed','unknown','cancelled')),
  response_id text, error text, updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(job_id, part)
);
CREATE TABLE life_blobs (
  hash text PRIMARY KEY CHECK (hash ~ '^[a-f0-9]{64}$'), path text NOT NULL,
  bytes bigint NOT NULL CHECK (bytes >= 0), mime text NOT NULL
);
CREATE TABLE life_event_media (
  event_id uuid NOT NULL REFERENCES life_events(id) ON DELETE CASCADE,
  hash text NOT NULL REFERENCES life_blobs(hash), role text NOT NULL,
  PRIMARY KEY(event_id, hash, role)
);
CREATE TABLE life_rates (
  token text PRIMARY KEY, bucket text NOT NULL, at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX life_rates_window ON life_rates(bucket, at);
CREATE TABLE life_legacy_seen (key text PRIMARY KEY);
INSERT INTO life_migrations(version) VALUES (1);
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
COMMIT;
