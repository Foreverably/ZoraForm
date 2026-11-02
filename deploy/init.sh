#!/bin/sh
set -eu

psql -v ON_ERROR_STOP=1 --set=app_password="$POSTGRES_PASSWORD" \
	--set=app_user="$POSTGRES_APP_USER" --set=database="$POSTGRES_DB" \
	--username postgres --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE :"app_user" WITH LOGIN PASSWORD :'app_password';
ALTER DATABASE :"database" OWNER TO :"app_user";
GRANT ALL PRIVILEGES ON DATABASE :"database" TO :"app_user";
GRANT ALL PRIVILEGES ON SCHEMA public TO :"app_user";
ALTER SCHEMA public OWNER TO :"app_user";
SQL
