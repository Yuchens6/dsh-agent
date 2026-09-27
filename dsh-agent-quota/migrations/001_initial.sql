CREATE TABLE quota.schema_migrations(version integer PRIMARY KEY);
CREATE TABLE quota.tenants(tenant_id text PRIMARY KEY);
CREATE TABLE quota.reservations(
 run_id uuid PRIMARY KEY, tenant_id text NOT NULL, owner_uid text NOT NULL,
 budget bigint NOT NULL CHECK(budget>=0), day date NOT NULL,
 deadline_at timestamptz, closed boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quota_daily ON quota.reservations(tenant_id,day,owner_uid);
CREATE INDEX quota_active ON quota.reservations(tenant_id,deadline_at) WHERE NOT closed;
INSERT INTO quota.schema_migrations VALUES(1);
