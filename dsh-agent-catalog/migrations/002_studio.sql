CREATE TABLE catalog.studio_agents (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  slug text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  base_id text NOT NULL,
  base_version integer NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,slug),
  FOREIGN KEY(id,version) REFERENCES catalog.definitions(id,version),
  FOREIGN KEY(base_id,base_version) REFERENCES catalog.definitions(id,version)
);
INSERT INTO catalog.schema_migrations(version) VALUES(2);
