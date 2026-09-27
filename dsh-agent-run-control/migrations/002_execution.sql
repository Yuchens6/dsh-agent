ALTER TABLE run_control.runs ADD COLUMN execution_input jsonb;
CREATE TABLE run_control.result_projections (
  run_id uuid PRIMARY KEY REFERENCES run_control.runs(id),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  projected_at timestamptz
);
CREATE INDEX result_projections_pending ON run_control.result_projections(next_attempt_at)
  WHERE projected_at IS NULL;
-- 不自动回填升级前的回答，避免把测试执行结果写入真实会话。
INSERT INTO run_control.schema_migrations(version) VALUES (2);
