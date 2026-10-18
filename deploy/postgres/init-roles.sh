#!/bin/sh
set -eu

# Generic backup/restore probes can use this image without Zephium account roles.
if [ "${ZEPHIUM_BOOTSTRAP_ROLES:-false}" != "true" ]; then exit 0; fi

: "${POSTGRES_USER:?}"
: "${POSTGRES_DB:?}"
: "${ZEPHIUM_MIGRATOR_PASSWORD:?}"
: "${ZEPHIUM_APP_PASSWORD:?}"

# The official PostgreSQL entrypoint runs this only for a fresh data volume.
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
  -f /etc/zephium/roles.sql
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v ON_ERROR_STOP=1 <<'SQL'
\getenv migrator_password ZEPHIUM_MIGRATOR_PASSWORD
\getenv app_password ZEPHIUM_APP_PASSWORD
ALTER ROLE zephium_migrator PASSWORD :'migrator_password';
ALTER ROLE zephium_app PASSWORD :'app_password';
SQL
