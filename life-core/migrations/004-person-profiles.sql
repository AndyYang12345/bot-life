BEGIN;
ALTER TABLE life_conversations ADD COLUMN identity_realm text;
ALTER TABLE life_conversations ADD COLUMN identity_platform text;
ALTER TABLE life_conversations ADD COLUMN profile_sharing boolean NOT NULL DEFAULT false;
CREATE TABLE life_people (
  id uuid PRIMARY KEY, realm text NOT NULL, platform text NOT NULL, platform_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), last_seen timestamptz NOT NULL DEFAULT now(),
  UNIQUE(realm,platform,platform_user_id)
);
CREATE TABLE life_conversation_people (
  conversation text NOT NULL REFERENCES life_conversations(key) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES life_people(id) ON DELETE CASCADE,
  first_seen timestamptz NOT NULL DEFAULT now(), last_seen timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(conversation,person_id)
);
CREATE INDEX life_conversation_people_person ON life_conversation_people(person_id);
CREATE TABLE life_person_aliases (
  person_id uuid NOT NULL REFERENCES life_people(id) ON DELETE CASCADE,
  conversation text NOT NULL REFERENCES life_conversations(key) ON DELETE CASCADE,
  name text NOT NULL, first_seen timestamptz NOT NULL DEFAULT now(), last_seen timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(person_id,conversation,name)
);
ALTER TABLE life_memories ADD COLUMN person_id uuid REFERENCES life_people(id) ON DELETE CASCADE;
ALTER TABLE life_memories ADD COLUMN visibility text NOT NULL DEFAULT 'conversation' CHECK(visibility IN ('conversation','person'));
ALTER TABLE life_memories ADD COLUMN share_category text CHECK(share_category IN ('preference','communication'));
ALTER TABLE life_memories ADD COLUMN ownership_scope text;
UPDATE life_memories SET ownership_scope='conversation:'||conversation;
-- Existing bigram-only documents also need single-character Chinese queries.
UPDATE life_memories m SET search_terms=m.search_terms||' '||COALESCE((
  SELECT string_agg(DISTINCT token,' ') FROM regexp_split_to_table(m.content||' '||m.summary,'') AS chars(token)
  WHERE token~'^[一-鿿]$'
),'');
ALTER TABLE life_memories ALTER COLUMN ownership_scope SET NOT NULL;
ALTER TABLE life_memories ADD CONSTRAINT life_memory_ownership CHECK (
  (visibility='conversation' AND ownership_scope='conversation:'||conversation AND share_category IS NULL)
  OR (visibility='person' AND person_id IS NOT NULL AND subject_type='user' AND type='semantic'
      AND sensitivity='internal' AND share_category IS NOT NULL AND ownership_scope='person:'||person_id::text)
);
ALTER TABLE life_memories DROP CONSTRAINT life_memories_conversation_content_hash_key;
ALTER TABLE life_memories ADD UNIQUE(ownership_scope,content_hash);
CREATE INDEX life_memory_person_visibility ON life_memories(person_id,visibility,status);
GRANT SELECT,INSERT,UPDATE ON life_people,life_conversation_people,life_person_aliases TO life_app;
INSERT INTO life_migrations(version) VALUES(4);
COMMIT;
