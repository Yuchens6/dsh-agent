CREATE TABLE audit.schema_migrations(version integer PRIMARY KEY);
CREATE TABLE audit.records(
 event_id uuid PRIMARY KEY, tenant_id text NOT NULL, owner_uid text NOT NULL,
 run_id uuid NOT NULL, envelope jsonb NOT NULL, received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_owner ON audit.records(tenant_id,owner_uid,event_id DESC);
CREATE FUNCTION audit.reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Audit records are append-only'; END $$;
CREATE TRIGGER immutable_records BEFORE UPDATE OR DELETE ON audit.records FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON audit.records FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_mutation();
INSERT INTO audit.schema_migrations VALUES(1);
