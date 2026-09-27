CREATE INDEX runs_dispatch_active ON run_control.runs(tenant_id,owner_uid,lease_expires_at)
 WHERE state IN ('running','canceled');
INSERT INTO run_control.schema_migrations(version) VALUES(6);
