CREATE TABLE quota.points_prices(id uuid PRIMARY KEY, document jsonb NOT NULL);
CREATE TABLE quota.points_active_prices(provider text NOT NULL, model text NOT NULL, price_id uuid NOT NULL REFERENCES quota.points_prices(id), PRIMARY KEY(provider,model));
CREATE TABLE quota.points_accounts(tenant_id text NOT NULL, owner_uid text NOT NULL, balance numeric(38,0) NOT NULL DEFAULT 0 CHECK(balance>=0), held numeric(38,0) NOT NULL DEFAULT 0 CHECK(held>=0 AND held<=balance), PRIMARY KEY(tenant_id,owner_uid));
CREATE TABLE quota.points_operations(id uuid PRIMARY KEY, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE quota.points_runs(run_id uuid PRIMARY KEY REFERENCES quota.reservations(run_id), tenant_id text NOT NULL, owner_uid text NOT NULL,
 price jsonb NOT NULL, remaining_hold numeric(38,0) NOT NULL CHECK(remaining_hold>=0), expected_calls integer CHECK(expected_calls BETWEEN 0 AND 50), released boolean NOT NULL DEFAULT false);
CREATE INDEX points_runs_owner ON quota.points_runs(tenant_id,owner_uid) WHERE NOT released;
CREATE TABLE quota.points_charges(run_id uuid NOT NULL REFERENCES quota.points_runs(run_id), attempt integer NOT NULL, call integer NOT NULL,
 status text NOT NULL CHECK(status IN ('pending_usage','pending_balance','settled')), amount numeric(38,0), points numeric(38,0), PRIMARY KEY(run_id,attempt,call));
CREATE TABLE quota.points_ledger(id uuid PRIMARY KEY, tenant_id text NOT NULL, owner_uid text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('grant','allocate','charge')), delta numeric(38,0) NOT NULL, run_id uuid REFERENCES quota.points_runs(run_id),
 attempt integer, call integer, UNIQUE(run_id,attempt,call),
 amount numeric(38,0), price_id uuid REFERENCES quota.points_prices(id), operation_id uuid REFERENCES quota.points_operations(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(kind<>'charge' OR (run_id IS NOT NULL AND attempt>0 AND call BETWEEN 1 AND 50 AND attempt IS NOT NULL AND call IS NOT NULL AND amount>=0 AND amount IS NOT NULL AND delta<=0 AND price_id IS NOT NULL)));
CREATE INDEX points_ledger_owner ON quota.points_ledger(tenant_id,owner_uid,id);
CREATE FUNCTION quota.points_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'points record is append-only'; END $$;
CREATE TRIGGER immutable_prices BEFORE UPDATE OR DELETE OR TRUNCATE ON quota.points_prices FOR EACH STATEMENT EXECUTE FUNCTION quota.points_immutable();
CREATE TRIGGER immutable_operations BEFORE UPDATE OR DELETE OR TRUNCATE ON quota.points_operations FOR EACH STATEMENT EXECUTE FUNCTION quota.points_immutable();
CREATE TRIGGER immutable_ledger BEFORE UPDATE OR DELETE OR TRUNCATE ON quota.points_ledger FOR EACH STATEMENT EXECUTE FUNCTION quota.points_immutable();
INSERT INTO quota.schema_migrations(version) VALUES(3);
