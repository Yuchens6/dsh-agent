ALTER TABLE run_control.runs ADD COLUMN progress_sequence integer NOT NULL DEFAULT 0;
ALTER TABLE run_control.runs ADD COLUMN progress_bytes integer NOT NULL DEFAULT 0;
ALTER TABLE run_control.runs ADD COLUMN event_dispatch_at timestamptz;
CREATE TABLE run_control.progress_receipts (
  run_id uuid NOT NULL REFERENCES run_control.runs(id),
  attempt integer NOT NULL,
  sequence integer NOT NULL,
  request_hash text NOT NULL,
  PRIMARY KEY(run_id, attempt, sequence)
);
INSERT INTO run_control.schema_migrations(version) VALUES(7);
