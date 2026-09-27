CREATE TABLE IF NOT EXISTS run_control.schema_migrations (
  version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE run_control.scheduler (id integer PRIMARY KEY CHECK(id=1));
INSERT INTO run_control.scheduler VALUES(1);
CREATE TABLE run_control.runs (
  id uuid PRIMARY KEY, enqueue_sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  tenant_id text NOT NULL, owner_uid text NOT NULL, session_id uuid NOT NULL, message_id uuid NOT NULL,
  state text NOT NULL CHECK(state IN ('queued','running','succeeded','failed','canceled')),
  attempt integer NOT NULL DEFAULT 0, worker_id text, lease_id uuid,
  lease_expires_at timestamptz, deadline_at timestamptz,
  output text, failure_code text, result_hash text,
  trace_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(session_id,message_id),
  CHECK ((state='succeeded' AND output IS NOT NULL) OR (state<>'succeeded' AND output IS NULL)),
  CHECK (state<>'running' OR (lease_id IS NOT NULL AND worker_id IS NOT NULL AND lease_expires_at IS NOT NULL AND deadline_at IS NOT NULL))
);
CREATE INDEX runs_owner ON run_control.runs(tenant_id,owner_uid,id DESC);
CREATE INDEX runs_session ON run_control.runs(session_id,state,enqueue_sequence);
CREATE INDEX runs_queue ON run_control.runs(enqueue_sequence) WHERE state='queued';
CREATE INDEX runs_expiry ON run_control.runs(lease_expires_at) WHERE state='running';
CREATE TABLE run_control.inbox (
  event_id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES run_control.runs(id), received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE run_control.rejected_requests (
  stream_sequence bigint PRIMARY KEY, reason text NOT NULL, received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE run_control.outbox (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE, run_id uuid NOT NULL REFERENCES run_control.runs(id),
  subject text NOT NULL, envelope jsonb NOT NULL, published_at timestamptz
);
CREATE INDEX run_outbox_pending ON run_control.outbox(run_id,sequence) WHERE published_at IS NULL;
INSERT INTO run_control.schema_migrations(version) VALUES(1);
