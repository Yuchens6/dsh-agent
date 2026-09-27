CREATE TABLE run_control.workflow_steps (
 run_id uuid NOT NULL REFERENCES run_control.runs(id), attempt integer NOT NULL, step_id text NOT NULL,
 position integer NOT NULL CHECK(position BETWEEN 0 AND 7), state text NOT NULL CHECK(state IN ('running','succeeded','skipped')),
 output text, started_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
 PRIMARY KEY(run_id,attempt,step_id), UNIQUE(run_id,attempt,position)
);
ALTER TABLE run_control.model_calls ADD COLUMN step_id text;
INSERT INTO run_control.schema_migrations(version) VALUES(5);
