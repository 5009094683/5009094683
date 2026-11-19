#!/usr/bin/env bash
# Drops and recreates the local development database, then applies migrations.
# Development only: it destroys all data in the target database.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

URL="${DATABASE_URL:-postgres://pms:pms@localhost:5432/pms}"
DB_NAME="$(node -e 'console.log(new URL(process.argv[1]).pathname.slice(1))' "$URL")"
ADMIN_URL="$(node -e 'const u = new URL(process.argv[1]); u.pathname = "/postgres"; console.log(u.toString())' "$URL")"

case "$URL" in
  *localhost*|*127.0.0.1*) ;;
  *)
    echo "Refusing to reset a database that is not on localhost: $URL" >&2
    exit 1
    ;;
esac

psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS \"$DB_NAME\" WITH (FORCE)"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE \"$DB_NAME\""
pnpm --filter @pms/db migrate
