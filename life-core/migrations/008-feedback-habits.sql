BEGIN;
CREATE TABLE life_habits (
  id uuid PRIMARY KEY, realm text NOT NULL,
  scope text NOT NULL CHECK(scope IN ('person','conversation','global')),
  subject_key text NOT NULL, person_id uuid REFERENCES life_people(id) ON DELETE CASCADE,
  conversation text REFERENCES life_conversations(key) ON DELETE CASCADE,
  setting text NOT NULL, value text NOT NULL,
  status text NOT NULL CHECK(status IN ('active','revoked')),
  revision integer NOT NULL DEFAULT 1,
  source_id uuid NOT NULL REFERENCES life_events(id) ON DELETE CASCADE,
  source_conversation text NOT NULL REFERENCES life_conversations(key) ON DELETE CASCADE,
  actor_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(realm,scope,subject_key,setting),
  CHECK((scope='person' AND person_id IS NOT NULL AND conversation IS NULL)
    OR (scope='conversation' AND conversation IS NOT NULL AND person_id IS NULL)
    OR (scope='global' AND person_id IS NULL AND conversation IS NULL))
);
CREATE INDEX life_habits_context ON life_habits(realm,scope,subject_key,status);
CREATE TABLE life_habit_revisions (
  habit_id uuid NOT NULL REFERENCES life_habits(id) ON DELETE CASCADE,
  revision integer NOT NULL, source_id uuid NOT NULL REFERENCES life_events(id) ON DELETE CASCADE,
  actor_id text NOT NULL, quote text NOT NULL, payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(habit_id,revision)
);
CREATE TABLE life_habit_ops (
  job_id uuid NOT NULL REFERENCES life_events(id) ON DELETE CASCADE,
  operation_key text NOT NULL, result jsonb NOT NULL, PRIMARY KEY(job_id,operation_key)
);
INSERT INTO life_settings VALUES('habit_writes_paused','false');
GRANT SELECT,INSERT,UPDATE ON life_habits TO life_app;
GRANT SELECT,INSERT ON life_habit_revisions,life_habit_ops TO life_app;
INSERT INTO life_migrations(version) VALUES(8);
COMMIT;
