CREATE TABLE IF NOT EXISTS catalog.schema_migrations (
  version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE catalog.definitions (
  id text NOT NULL, version integer NOT NULL CHECK (version > 0),
  document jsonb NOT NULL, document_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(id, version)
);
CREATE FUNCTION catalog.reject_definition_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Published agent definitions are immutable';
END
$$;
CREATE TRIGGER definition_immutable BEFORE UPDATE OR DELETE ON catalog.definitions
FOR EACH ROW EXECUTE FUNCTION catalog.reject_definition_change();
CREATE TABLE catalog.tenant_definitions (
  tenant_id text NOT NULL, definition_id text NOT NULL, definition_version integer NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  PRIMARY KEY(tenant_id, definition_id, definition_version),
  FOREIGN KEY(definition_id,definition_version) REFERENCES catalog.definitions(id,version)
);
CREATE UNIQUE INDEX one_tenant_default ON catalog.tenant_definitions(tenant_id) WHERE is_default;
INSERT INTO catalog.schema_migrations(version) VALUES(1);
