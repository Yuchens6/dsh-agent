CREATE TABLE chat.audit_outbox (
 event_id uuid PRIMARY KEY, envelope jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), next_attempt_at timestamptz NOT NULL DEFAULT now(),
 attempts integer NOT NULL DEFAULT 0, delivered_at timestamptz
);
CREATE INDEX audit_pending ON chat.audit_outbox(next_attempt_at,event_id) WHERE delivered_at IS NULL;
-- 只审计升级后发生的变更，不从历史业务表伪造回填。
INSERT INTO chat.schema_migrations(version) VALUES(4);
