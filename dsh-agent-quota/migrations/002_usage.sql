CREATE TABLE quota.model_calls (
 run_id uuid NOT NULL, attempt integer NOT NULL, call integer NOT NULL CHECK(call BETWEEN 1 AND 50),
 tenant_id text NOT NULL, owner_uid text NOT NULL, provider text NOT NULL, model text NOT NULL,
 started_at timestamptz NOT NULL, finished boolean NOT NULL DEFAULT false, tokens jsonb,
 PRIMARY KEY(run_id,attempt,call)
);
CREATE INDEX model_calls_owner_day ON quota.model_calls(tenant_id,owner_uid,started_at);
INSERT INTO quota.schema_migrations(version) VALUES(2);
