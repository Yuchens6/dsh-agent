ALTER TABLE run_control.support_outbox DROP CONSTRAINT support_outbox_kind_check;
ALTER TABLE run_control.support_outbox ADD CONSTRAINT support_outbox_kind_check CHECK(kind IN ('audit','quota-close','model-usage'));
CREATE TABLE run_control.model_calls (
 run_id uuid NOT NULL REFERENCES run_control.runs(id), attempt integer NOT NULL, call integer NOT NULL CHECK(call BETWEEN 1 AND 50),
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(), final_report jsonb,
 PRIMARY KEY(run_id,attempt,call)
);
INSERT INTO run_control.schema_migrations(version) VALUES(4);
