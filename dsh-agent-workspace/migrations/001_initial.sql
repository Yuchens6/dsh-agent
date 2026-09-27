CREATE TABLE IF NOT EXISTS workspace.schema_migrations (
  version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE workspace.workspaces (
  id uuid PRIMARY KEY, tenant_id text NOT NULL, owner_uid text NOT NULL,
  used_bytes bigint NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  file_count integer NOT NULL DEFAULT 0 CHECK (file_count >= 0),
  reserved_bytes bigint NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, owner_uid)
);
CREATE TABLE workspace.blobs (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspace.workspaces(id),
  object_key text NOT NULL UNIQUE, size_bytes integer NOT NULL CHECK(size_bytes >= 0),
  state text NOT NULL CHECK(state IN ('staged','live','retired')),
  created_at timestamptz NOT NULL DEFAULT now(), retired_at timestamptz
);
CREATE INDEX blobs_gc ON workspace.blobs(state, created_at);
CREATE INDEX blobs_workspace_state ON workspace.blobs(workspace_id, state);
CREATE TABLE workspace.files (
  workspace_id uuid NOT NULL REFERENCES workspace.workspaces(id),
  path text COLLATE "C" NOT NULL, blob_id uuid NOT NULL REFERENCES workspace.blobs(id),
  size_bytes integer NOT NULL CHECK(size_bytes >= 0), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, path), UNIQUE(blob_id)
);
INSERT INTO workspace.schema_migrations(version) VALUES(1);
