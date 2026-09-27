CREATE TABLE IF NOT EXISTS chat.schema_migrations (
  version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE chat.conversations (
  id uuid PRIMARY KEY,
  tenant_id varchar(128) NOT NULL,
  owner_uid varchar(128) NOT NULL,
  title varchar(200) NOT NULL,
  agent_definition_id text NOT NULL,
  agent_definition_version integer NOT NULL CHECK (agent_definition_version > 0),
  workspace_id uuid,
  idempotency_key varchar(128) NOT NULL,
  request_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, owner_uid, idempotency_key)
);
CREATE INDEX conversations_owner ON chat.conversations (tenant_id, owner_uid, id DESC);
CREATE TABLE chat.conversation_messages (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES chat.conversations(id),
  tenant_id varchar(128) NOT NULL,
  owner_uid varchar(128) NOT NULL,
  role text NOT NULL CHECK (role = 'user'),
  content text NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  request_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, idempotency_key)
);
CREATE INDEX messages_owner ON chat.conversation_messages (tenant_id, owner_uid, session_id, id);
CREATE TABLE chat.conversation_outbox (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE,
  session_id uuid NOT NULL REFERENCES chat.conversations(id),
  subject text NOT NULL,
  envelope jsonb NOT NULL,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending ON chat.conversation_outbox (session_id, sequence)
  WHERE published_at IS NULL;
INSERT INTO chat.schema_migrations(version) VALUES (1);
