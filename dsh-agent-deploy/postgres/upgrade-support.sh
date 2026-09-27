#!/usr/bin/env bash
set -euo pipefail
# 可重复运行，不覆盖已有密码、不删除数据；审计在线账号没有更新、删除或模式所有权。
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 \
  --set quota_password="$QUOTA_DB_PASSWORD" --set audit_password="$AUDIT_DB_PASSWORD" --set audit_writer_password="$AUDIT_WRITER_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE quota LOGIN PASSWORD %L', :'quota_password') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='quota') \gexec
SELECT format('CREATE ROLE audit LOGIN PASSWORD %L', :'audit_password') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='audit') \gexec
SELECT format('CREATE ROLE audit_writer LOGIN PASSWORD %L', :'audit_writer_password') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='audit_writer') \gexec
GRANT CONNECT, TEMPORARY ON DATABASE agent TO quota, audit, audit_writer;
CREATE SCHEMA IF NOT EXISTS quota AUTHORIZATION quota;
CREATE SCHEMA IF NOT EXISTS audit AUTHORIZATION audit;
GRANT USAGE ON SCHEMA audit TO audit_writer;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA audit TO audit_writer;
ALTER DEFAULT PRIVILEGES FOR ROLE audit IN SCHEMA audit GRANT SELECT, INSERT ON TABLES TO audit_writer;
ALTER ROLE quota SET search_path TO quota;
ALTER ROLE audit SET search_path TO audit;
ALTER ROLE audit_writer SET search_path TO audit;
SQL
