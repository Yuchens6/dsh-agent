CREATE TABLE chat.message_admission (
 tenant_id text NOT NULL, owner_uid text NOT NULL,
 window_start timestamptz NOT NULL, used integer NOT NULL CHECK(used>=0),
 PRIMARY KEY(tenant_id,owner_uid)
);
CREATE INDEX outbox_pending_actor ON chat.conversation_outbox ((envelope->>'tenantId'),(envelope->>'ownerUid'))
 WHERE published_at IS NULL AND subject='agent.commands.run.requested.v1';
INSERT INTO chat.schema_migrations(version) VALUES(5);
