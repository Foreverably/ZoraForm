#!/bin/sh
set -eu
app_password=$(cat /run/secrets/app_password)
psql -v ON_ERROR_STOP=1 --username postgres --dbname zoraforms <<SQL
CREATE ROLE zoraforms WITH LOGIN PASSWORD '$app_password';
ALTER DATABASE zoraforms OWNER TO zoraforms;
GRANT ALL ON SCHEMA public TO zoraforms;
SQL
