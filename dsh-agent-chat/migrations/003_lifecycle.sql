ALTER TABLE chat.conversations ADD COLUMN archived boolean NOT NULL DEFAULT false;
ALTER TABLE chat.conversations ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision>0);
INSERT INTO chat.schema_migrations(version) VALUES(3);
