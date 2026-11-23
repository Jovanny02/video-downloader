#!/bin/sh
set -eu
psql --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=worker_password="$WORKER_PASSWORD" --set=api_password="$API_PASSWORD" <<'SQL'
CREATE ROLE download_submitter NOLOGIN;
CREATE USER vod_worker PASSWORD :'worker_password';
CREATE USER vod_api PASSWORD :'api_password' IN ROLE download_submitter;
ALTER DATABASE vod OWNER TO vod_worker;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL
