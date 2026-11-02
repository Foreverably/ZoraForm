#!/bin/sh
set -eu

psql -v ON_ERROR_STOP=1 --set=app_password="$POSTGRES_PASSWORD" --username postgres --dbname zoraformsdata <<SQL
CREATE ROLE zoraforms WITH LOGIN PASSWORD :'app_password';
ALTER DATABASE zoraformsdata OWNER TO zoraforms;
GRANT ALL PRIVILEGES ON DATABASE zoraformsdata TO zoraforms;
GRANT ALL PRIVILEGES ON SCHEMA public TO zoraforms;
ALTER SCHEMA public OWNER TO zoraforms;
SQL
