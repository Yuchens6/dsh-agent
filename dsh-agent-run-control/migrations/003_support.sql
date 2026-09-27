CREATE TABLE run_control.support_outbox (
 id uuid PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('audit','quota-close')),
 payload jsonb NOT NULL, attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_pending ON run_control.support_outbox(next_attempt_at) WHERE delivered_at IS NULL;
-- 老运行没有预留，不追溯扣费；历史审计不伪造回填。
INSERT INTO run_control.schema_migrations(version) VALUES(3);
