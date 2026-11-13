#!/usr/bin/env bash
# Brings up the services a developer or agent needs on every boot: PostgreSQL,
# then the dev database schema. Safe to rerun. It does not install anything.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
fi

if ! pg_isready -q -h localhost -p 5432; then
  echo "[start] starting PostgreSQL"
  $SUDO service postgresql start
fi
for _ in $(seq 1 60); do
  pg_isready -q -h localhost -p 5432 && break
  sleep 1
done
pg_isready -h localhost -p 5432

if [ -d node_modules ] && [ -f packages/db/package.json ]; then
  echo "[start] applying database migrations"
  pnpm --filter @pms/db migrate
fi

echo "[start] ready"
