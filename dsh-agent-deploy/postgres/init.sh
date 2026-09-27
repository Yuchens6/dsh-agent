#!/usr/bin/env bash
set -euo pipefail
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 \
  --set chat_password="$CHAT_DB_PASSWORD" --set iam_password="$IAM_DB_PASSWORD" \
  --set workspace_password="$WORKSPACE_DB_PASSWORD" --set catalog_password="$CATALOG_DB_PASSWORD" \
  --set catalog_read_password="$CATALOG_READ_DB_PASSWORD" --set run_control_password="$RUN_CONTROL_DB_PASSWORD" <<'SQL'
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE agent FROM PUBLIC;
CREATE ROLE chat LOGIN PASSWORD :'chat_password';
CREATE ROLE iam LOGIN PASSWORD :'iam_password';
CREATE ROLE workspace LOGIN PASSWORD :'workspace_password';
CREATE ROLE catalog LOGIN PASSWORD :'catalog_password';
CREATE ROLE catalog_reader LOGIN PASSWORD :'catalog_read_password';
CREATE ROLE run_control LOGIN PASSWORD :'run_control_password';
GRANT CONNECT, TEMPORARY ON DATABASE agent TO chat, iam, workspace, catalog, catalog_reader, run_control;
CREATE SCHEMA chat AUTHORIZATION chat;
CREATE SCHEMA iam AUTHORIZATION iam;
CREATE SCHEMA workspace AUTHORIZATION workspace;
CREATE SCHEMA catalog AUTHORIZATION catalog;
CREATE SCHEMA run_control AUTHORIZATION run_control;
GRANT USAGE ON SCHEMA catalog TO catalog_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE catalog IN SCHEMA catalog GRANT SELECT ON TABLES TO catalog_reader;
ALTER ROLE chat SET search_path TO chat;
ALTER ROLE iam SET search_path TO iam;
ALTER ROLE workspace SET search_path TO workspace;
ALTER ROLE catalog SET search_path TO catalog;
ALTER ROLE catalog_reader SET search_path TO catalog;
ALTER ROLE run_control SET search_path TO run_control;
SQL
bash /opt/platform/upgrade-support.sh
