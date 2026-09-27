#!/usr/bin/env bash
set -euo pipefail
# 只补充新服务角色和模式，不修改已存在账号密码，不删除数据。
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 \
  --set workspace_password="$WORKSPACE_DB_PASSWORD" --set catalog_password="$CATALOG_DB_PASSWORD" \
  --set catalog_read_password="$CATALOG_READ_DB_PASSWORD" --set run_control_password="$RUN_CONTROL_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE workspace LOGIN PASSWORD %L', :'workspace_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='workspace') \gexec
SELECT format('CREATE ROLE catalog LOGIN PASSWORD %L', :'catalog_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='catalog') \gexec
SELECT format('CREATE ROLE catalog_reader LOGIN PASSWORD %L', :'catalog_read_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='catalog_reader') \gexec
SELECT format('CREATE ROLE run_control LOGIN PASSWORD %L', :'run_control_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='run_control') \gexec
GRANT CONNECT, TEMPORARY ON DATABASE agent TO workspace, catalog, catalog_reader, run_control;
CREATE SCHEMA IF NOT EXISTS workspace AUTHORIZATION workspace;
CREATE SCHEMA IF NOT EXISTS catalog AUTHORIZATION catalog;
CREATE SCHEMA IF NOT EXISTS run_control AUTHORIZATION run_control;
GRANT USAGE ON SCHEMA catalog TO catalog_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA catalog TO catalog_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE catalog IN SCHEMA catalog GRANT SELECT ON TABLES TO catalog_reader;
ALTER ROLE workspace SET search_path TO workspace;
ALTER ROLE catalog SET search_path TO catalog;
ALTER ROLE catalog_reader SET search_path TO catalog;
ALTER ROLE run_control SET search_path TO run_control;
SQL
