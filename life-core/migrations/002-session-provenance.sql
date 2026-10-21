BEGIN;
CREATE TABLE life_session_links (
  conversation text NOT NULL REFERENCES life_conversations(key), session_id text NOT NULL,
  PRIMARY KEY(conversation, session_id)
);
INSERT INTO life_session_links SELECT key,session_id FROM life_conversations WHERE session_id IS NOT NULL;
GRANT SELECT,INSERT ON life_session_links TO life_app;
INSERT INTO life_migrations(version) VALUES (2);
COMMIT;
